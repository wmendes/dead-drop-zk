const { Server: RpcServer } = require('@stellar/stellar-sdk/rpc');
const StellarSdk = require('@stellar/stellar-sdk');
const { xdr } = StellarSdk;

// Debug: Check if Address is available
if (!StellarSdk.Address) {
  console.warn('[EventIndexer] Warning: Address not found in stellar-sdk, using fallback parser');
}
const Address = StellarSdk.Address;

const POLL_INTERVAL_MS = 5000; // Poll every 5 seconds
const SAFE_LEDGER_BUFFER = 5; // Stay 5 ledgers behind to avoid RPC lag
const INITIAL_BACKFILL_LEDGERS = 240; // Initial history to fetch

/**
 * Event Indexer - Continuously polls RPC for contract events and caches them by session.
 * Eliminates client-side cursor management issues by maintaining a single source of truth.
 */
class EventIndexer {
  constructor(contractId, rpcUrl) {
    this.contractId = contractId;
    this.server = new RpcServer(rpcUrl);
    this.cursor = null; // Start from recent history on first poll
    this.eventCache = new Map(); // session_id -> PingEvent[]
    this.isRunning = false;
    this.pollLoopPromise = null;
  }

  async start() {
    if (this.isRunning) {
      console.log('[EventIndexer] Already running');
      return;
    }
    this.isRunning = true;
    console.log('[EventIndexer] Starting for contract:', this.contractId);
    this.pollLoopPromise = this.pollLoop();
  }

  async stop() {
    this.isRunning = false;
    if (this.pollLoopPromise) {
      await this.pollLoopPromise;
    }
    console.log('[EventIndexer] Stopped');
  }

  async pollLoop() {
    while (this.isRunning) {
      try {
        await this.pollEvents();
      } catch (error) {
        console.error('[EventIndexer] Poll error:', error.message || error);
      }
      await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  }

  async pollEvents() {
    const latest = await this.server.getLatestLedger();
    const safeMax = latest.sequence - SAFE_LEDGER_BUFFER;

    // Initialize cursor to recent history on first run
    if (this.cursor === null) {
      this.cursor = Math.max(1, safeMax - INITIAL_BACKFILL_LEDGERS);
      console.log('[EventIndexer] Initialized cursor:', this.cursor, 'safeMax:', safeMax);
    }

    // Don't poll beyond safe max
    if (this.cursor >= safeMax) {
      return; // Wait for network to advance
    }

    const startLedger = this.cursor;

    let events;
    try {
      events = await this.server.getEvents({
        startLedger,
        filters: [{ type: 'contract', contractIds: [this.contractId] }],
        limit: 200,
      });
    } catch (err) {
      // Handle ledger range error (same as frontend)
      const range = this.parseLedgerRangeError(err);
      if (!range) throw err;

      console.warn('[EventIndexer] Ledger range error, resetting cursor', {
        requestedStart: startLedger,
        rangeMin: range.minLedger,
        rangeMax: range.maxLedger,
      });

      // Reset cursor to safe position
      this.cursor = Math.max(range.minLedger, range.maxLedger - INITIAL_BACKFILL_LEDGERS);
      return; // Retry on next poll
    }

    // Index events
    for (const event of events.events) {
      this.indexEvent(event);
    }

    // Advance cursor safely
    let maxLedgerSeen = startLedger;
    for (const event of events.events) {
      const ledger = Number(event.ledger);
      if (Number.isFinite(ledger) && ledger > maxLedgerSeen) {
        maxLedgerSeen = ledger;
      }
    }

    // Cap cursor at safe max (THIS IS THE KEY FIX)
    this.cursor = Math.min(maxLedgerSeen + 1, safeMax);

    if (events.events.length > 0) {
      console.log(`[EventIndexer] Indexed ${events.events.length} events, cursor: ${this.cursor}, safeMax: ${safeMax}`);
    }
  }

  indexEvent(event) {
    try {
      // Parse "ping" events (same logic as frontend)
      const topics = event.topic;
      if (!topics || topics.length < 2) return;

      const symbolXdr = topics[0]?.toXDR?.('base64');
      const expectedSymbol = xdr.ScVal.scvSymbol('ping').toXDR('base64');
      if (symbolXdr !== expectedSymbol) return;

      const sessionId = topics[1].u32();
      const value = event.value;

      if (value.switch().name !== 'scvVec') return;
      const vec = value.vec();
      if (!vec || vec.length < 5) return;

      // Parse player address from ScVal
      let playerAddress;
      try {
        if (Address && Address.fromScVal) {
          playerAddress = Address.fromScVal(vec[0]).toString();
        } else {
          // Fallback: manually parse address from ScVal
          const addrScVal = vec[0];
          if (addrScVal.switch().name === 'scvAddress') {
            playerAddress = addrScVal.address().toString();
          } else {
            console.warn('[EventIndexer] Unexpected player ScVal type:', addrScVal.switch().name);
            return;
          }
        }
      } catch (err) {
        console.error('[EventIndexer] Failed to parse player address:', err.message);
        return;
      }

      const pingEvent = {
        player: playerAddress,
        turn: vec[1].u32(),
        distance: vec[2].u32(),
        x: vec[3].u32(),
        y: vec[4].u32(),
        txHash: event.txHash,
        ledger: event.ledger,
      };

      // Deduplicate
      if (!this.eventCache.has(sessionId)) {
        this.eventCache.set(sessionId, []);
      }

      const existing = this.eventCache.get(sessionId);
      const isDuplicate = existing.some(
        e => e.txHash === pingEvent.txHash || (e.turn === pingEvent.turn && e.player === pingEvent.player)
      );

      if (!isDuplicate) {
        existing.push(pingEvent);
      }
    } catch (err) {
      console.error('[EventIndexer] Failed to parse event:', err.message || err);
    }
  }

  getEvents(sessionId) {
    return this.eventCache.get(sessionId) || [];
  }

  clearSession(sessionId) {
    this.eventCache.delete(sessionId);
    console.log('[EventIndexer] Cleared session cache:', sessionId);
  }

  parseLedgerRangeError(err) {
    const msg = err?.message || String(err);
    const match = msg.match(/\[(\d+),\s*(\d+)\]/);
    if (!match) return null;
    return { minLedger: parseInt(match[1]), maxLedger: parseInt(match[2]) };
  }
}

module.exports = { EventIndexer };
