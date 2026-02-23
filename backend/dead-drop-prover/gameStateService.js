const { Server: RpcServer } = require('@stellar/stellar-sdk/rpc');
const { Contract, Address, nativeToScVal, scValToNative, xdr } = require('@stellar/stellar-sdk');

/**
 * Game State Service - Provides unified game state + events via backend API.
 *
 * Benefits over direct frontend RPC polling:
 * - Caching reduces redundant RPC calls
 * - Single stable RPC connection (backend) vs many unstable frontend connections
 * - Merges contract state + indexed events in one response
 * - Graceful handling of RPC lag/errors
 */
class GameStateService {
  constructor(eventIndexer, contractId, rpcUrl) {
    this.eventIndexer = eventIndexer;
    this.contractId = contractId;
    this.server = new RpcServer(rpcUrl);
    this.contract = new Contract(contractId);
    this.cache = new Map(); // sessionId → { state, expiresAt }
    this.inFlight = new Map(); // sessionId → Promise<state>
    this.CACHE_TTL_MS = 2000; // 2 second cache to match 5s backend poll interval
  }

  /**
   * Get complete game state including contract data and indexed events.
   * Response is cached for 2 seconds to reduce RPC load.
   */
  async getGameState(sessionId) {
    // Check cache
    const cached = this.cache.get(sessionId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.state;
    }

    const existingInFlight = this.inFlight.get(sessionId);
    if (existingInFlight) {
      return existingInFlight;
    }

    const task = (async () => {
      // Fetch game state from contract
      let game = null;
      try {
        game = await this.fetchGameFromContract(sessionId);
      } catch (err) {
        // Game not found or RPC error - log and continue with null game
        console.warn(`[GameStateService] Could not fetch game ${sessionId}:`, err.message);
      }

      // Fetch indexed events (already cached in event indexer)
      const events = this.eventIndexer.getEvents(sessionId);

      // Get current ledger for consistency tracking
      const ledger = await this.getCurrentLedger();

      // Build combined response
      const state = {
        game: game || null,
        events: events || [],
        ledger: ledger,
        cached_at: Date.now(),
      };

      // Cache it, but never overwrite a newer snapshot with an older one.
      const existingCache = this.cache.get(sessionId);
      const existingLedger = Number(existingCache?.state?.ledger);
      const nextLedger = Number(state.ledger);
      const existingCachedAt = Number(existingCache?.state?.cached_at);
      const nextCachedAt = Number(state.cached_at);
      const hasExistingLedger = Number.isFinite(existingLedger);
      const hasNextLedger = Number.isFinite(nextLedger);
      const shouldKeepExisting =
        (hasExistingLedger && hasNextLedger && existingLedger > nextLedger) ||
        (
          hasExistingLedger &&
          hasNextLedger &&
          existingLedger === nextLedger &&
          Number.isFinite(existingCachedAt) &&
          existingCachedAt > nextCachedAt
        );

      if (!shouldKeepExisting) {
        this.cache.set(sessionId, {
          state,
          expiresAt: Date.now() + this.CACHE_TTL_MS,
        });
      }

      return state;
    })();

    this.inFlight.set(sessionId, task);
    try {
      return await task;
    } catch (error) {
      console.error('[GameStateService] getGameState error:', error);
      throw error;
    } finally {
      this.inFlight.delete(sessionId);
    }
  }

  /**
   * Fetch game state directly from contract storage.
   * Uses RPC getLedgerEntries to read temporary storage.
   */
  async fetchGameFromContract(sessionId) {
    try {
      // Build the storage key for game data
      // Dead Drop stores games in temporary storage with key: ("Game", session_id)
      // The key is a tuple of (Symbol("Game"), U32(session_id))
      const keyScVal = xdr.ScVal.scvVec([
        xdr.ScVal.scvSymbol('Game'),
        nativeToScVal(sessionId, { type: 'u32' })
      ]);

      // Build the ledger key XDR
      const contractAddress = Address.fromString(this.contractId).toScAddress();
      const ledgerKeyContractData = xdr.LedgerKey.contractData(
        new xdr.LedgerKeyContractData({
          contract: contractAddress,
          key: keyScVal,
          durability: xdr.ContractDataDurability.temporary(),
        })
      );

      // Query RPC
      const response = await this.server.getLedgerEntries(ledgerKeyContractData);

      if (!response || !response.entries || response.entries.length === 0) {
        return null; // Game not found
      }

      // Parse the contract data entry
      const entryData = response.entries[0];
      if (!entryData) {
        console.warn('[GameStateService] getLedgerEntries returned empty entry object', {
          sessionId,
          latestLedger: response.latestLedger ?? null,
        });
        return null;
      }

      let ledgerEntryData = null;
      // Current SDK shape: parsed ledger entry data is exposed as `entry.val`.
      if (entryData.val && typeof entryData.val.contractData === 'function') {
        ledgerEntryData = entryData.val;
      } else if (typeof entryData.xdr === 'string' && entryData.xdr) {
        // Backward-compatible fallback for raw entry payload shape.
        ledgerEntryData = xdr.LedgerEntryData.fromXDR(entryData.xdr, 'base64');
      } else {
        console.warn('[GameStateService] getLedgerEntries returned unsupported entry shape', {
          sessionId,
          latestLedger: response.latestLedger ?? null,
          entryKeys: Object.keys(entryData),
          hasVal: Boolean(entryData.val),
          valType: entryData.val?.constructor?.name ?? typeof entryData.val,
          hasXdr: typeof entryData.xdr === 'string' && entryData.xdr.length > 0,
        });
        return null;
      }

      const contractDataEntry = ledgerEntryData.contractData();
      const gameScVal = contractDataEntry.val();

      // Convert ScVal to native JavaScript object
      // This returns the Game struct as a native JS object
      const game = scValToNative(gameScVal);

      return game;
    } catch (err) {
      console.error('[GameStateService] fetchGameFromContract error:', err.message);
      if (err.stack) {
        console.error('[GameStateService] Stack trace:', err.stack);
      }
      return null;
    }
  }

  async getCurrentLedger() {
    try {
      const latest = await this.server.getLatestLedger();
      return latest.sequence;
    } catch (err) {
      console.error('[GameStateService] Failed to get current ledger:', err.message);
      return null;
    }
  }

  /**
   * Clear cache for a specific session (call after game mutations)
   */
  clearCache(sessionId) {
    this.cache.delete(sessionId);
    this.inFlight.delete(sessionId);
    console.log('[GameStateService] Cleared cache for session:', sessionId);
  }

  /**
   * Clear all expired cache entries (call periodically)
   */
  pruneCache() {
    const now = Date.now();
    let pruned = 0;
    for (const [sessionId, cached] of this.cache.entries()) {
      if (cached.expiresAt <= now) {
        this.cache.delete(sessionId);
        pruned++;
      }
    }
    if (pruned > 0) {
      console.log(`[GameStateService] Pruned ${pruned} expired cache entries`);
    }
  }
}

module.exports = { GameStateService };
