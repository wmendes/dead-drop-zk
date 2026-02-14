import { Client as DeadDropClient, type Game, type Lobby } from './bindings';
import {
  NETWORK_PASSPHRASE,
  RPC_URL,
  DEFAULT_METHOD_OPTIONS,
  DEFAULT_AUTH_TTL_MINUTES,
  MULTI_SIG_AUTH_TTL_MINUTES,
  RUNTIME_SIMULATION_SOURCE,
  DEV_PLAYER1_ADDRESS,
} from '@/utils/constants';
import { contract, TransactionBuilder, StrKey, xdr, Address, authorizeEntry, rpc } from '@stellar/stellar-sdk';
import { Buffer } from 'buffer';
import { signAndSendViaLaunchtube } from '@/utils/transactionHelper';
import { calculateValidUntilLedger } from '@/utils/ledgerUtils';
import { injectSignedAuthEntry } from '@/utils/authEntryUtils';

type ClientOptions = contract.ClientOptions;

/**
 * Service for interacting with the Dead Drop game contract.
 *
 * Contract methods:
 * - start_game: multi-sig (Player1 + Player2)
 * - commit_secret: single-sig
 * - submit_ping: single-sig (with ZK proof data)
 * - force_timeout: single-sig
 * - get_game: read-only
 */
export class DeadDropService {
  private baseClient: DeadDropClient;
  private contractId: string;
  private pingEventsCursorBySession = new Map<number, number>();
  private readonly initialPingEventsBackfill = 240;
  private readonly pingEventsRewind = 2;

  constructor(contractId: string) {
    this.contractId = contractId;
    this.baseClient = new DeadDropClient({
      contractId: this.contractId,
      networkPassphrase: NETWORK_PASSPHRASE,
      rpcUrl: RPC_URL,
    });
  }

  private resolveInvokerPublicKey(addressLike: string): string {
    if (StrKey.isValidEd25519PublicKey(addressLike)) return addressLike;
    if (StrKey.isValidEd25519PublicKey(RUNTIME_SIMULATION_SOURCE)) return RUNTIME_SIMULATION_SOURCE;
    if (StrKey.isValidEd25519PublicKey(DEV_PLAYER1_ADDRESS)) return DEV_PLAYER1_ADDRESS;
    throw new Error(
      'No valid fee-payer account configured. Set VITE_SIMULATION_SOURCE_ADDRESS or VITE_DEV_PLAYER1_ADDRESS.'
    );
  }

  private createSigningClient(
    publicKey: string,
    signer: Pick<contract.ClientOptions, 'signTransaction' | 'signAuthEntry'>
  ): DeadDropClient {
    return new DeadDropClient({
      contractId: this.contractId,
      networkPassphrase: NETWORK_PASSPHRASE,
      rpcUrl: RPC_URL,
      publicKey: this.resolveInvokerPublicKey(publicKey),
      ...signer,
    });
  }

  private ensureMutationSubmitted(
    action: string,
    sentTx: contract.SentTransaction<any>
  ): void {
    const txResponse = (sentTx as any)?.getTransactionResponse;
    const status = txResponse?.status as string | undefined;
    const hash = txResponse?.hash as string | undefined;

    if (status && status !== 'SUCCESS') {
      throw new Error(`${action} failed with status: ${status}`);
    }

    // If there's no response metadata at all, this likely fell back to a simulation-only path.
    if (!status && !hash) {
      throw new Error(
        `${action} did not submit to the network (no transaction hash/status returned).`
      );
    }
  }

  // ========================================================================
  // Read-only
  // ========================================================================

  async getGame(sessionId: number): Promise<Game | null> {
    try {
      const tx = await this.baseClient.get_game({ session_id: sessionId });
      const result = await tx.simulate();
      if (result.result.isOk()) {
        return result.result.unwrap();
      }
      return null;
    } catch {
      return null;
    }
  }

  async getLobby(sessionId: number): Promise<Lobby | null> {
    try {
      const tx = await this.baseClient.get_lobby({ session_id: sessionId });
      const result = await tx.simulate();
      if (result.result.isOk()) {
        return result.result.unwrap();
      }
      return null;
    } catch {
      return null;
    }
  }

  // ========================================================================
  // Multi-sig start flow (same as number-guess)
  // ========================================================================

  async prepareStartGame(
    sessionId: number,
    player1: string,
    player2: string,
    player1Points: bigint,
    player2Points: bigint,
    player1Signer: Pick<contract.ClientOptions, 'signTransaction' | 'signAuthEntry'>,
    authTtlMinutes?: number
  ): Promise<string> {
    const buildClient = new DeadDropClient({
      contractId: this.contractId,
      networkPassphrase: NETWORK_PASSPHRASE,
      rpcUrl: RPC_URL,
      publicKey: this.resolveInvokerPublicKey(player2),
    });

    const tx = await buildClient.start_game({
      session_id: sessionId,
      player1,
      player2,
      player1_points: player1Points,
      player2_points: player2Points,
    }, DEFAULT_METHOD_OPTIONS);

    if (!tx.simulationData?.result?.auth) {
      throw new Error('No auth entries found in simulation');
    }

    const authEntries = tx.simulationData.result.auth;
    let player1AuthEntry = null;
    for (let i = 0; i < authEntries.length; i++) {
      try {
        const entry = authEntries[i];
        const entryAddress = entry.credentials().address().address();
        const entryAddressString = Address.fromScAddress(entryAddress).toString();
        if (entryAddressString === player1) {
          player1AuthEntry = entry;
          break;
        }
      } catch {
        continue;
      }
    }

    if (!player1AuthEntry) {
      throw new Error(`No auth entry found for Player 1 (${player1})`);
    }

    const validUntilLedgerSeq = await calculateValidUntilLedger(
      RPC_URL, authTtlMinutes ?? MULTI_SIG_AUTH_TTL_MINUTES
    );

    if (!player1Signer.signAuthEntry) {
      throw new Error('signAuthEntry function not available');
    }

    const signedAuthEntry = await authorizeEntry(
      player1AuthEntry,
      async (preimage) => {
        const signResult = await player1Signer.signAuthEntry!(
          preimage.toXDR('base64'),
          { networkPassphrase: NETWORK_PASSPHRASE, address: player1 }
        );
        if (signResult.error) throw new Error(`Sign failed: ${signResult.error.message}`);
        return Buffer.from(signResult.signedAuthEntry, 'base64');
      },
      validUntilLedgerSeq,
      NETWORK_PASSPHRASE,
    );

    return signedAuthEntry.toXDR('base64');
  }

  parseAuthEntry(authEntryXdr: string): {
    sessionId: number;
    player1: string;
    player1Points: bigint;
    functionName: string;
  } {
    const authEntry = xdr.SorobanAuthorizationEntry.fromXDR(authEntryXdr, 'base64');
    const addressCreds = authEntry.credentials().address();
    const player1 = Address.fromScAddress(addressCreds.address()).toString();
    const contractFn = authEntry.rootInvocation().function().contractFn();
    const functionName = contractFn.functionName().toString();
    if (functionName !== 'start_game') {
      throw new Error(`Unexpected function: ${functionName}. Expected start_game.`);
    }
    const args = contractFn.args();
    if (args.length !== 2) {
      throw new Error(`Expected 2 auth args, got ${args.length}`);
    }
    return {
      sessionId: args[0].u32(),
      player1,
      player1Points: args[1].i128().lo().toBigInt(),
      functionName,
    };
  }

  async importAndSignAuthEntry(
    player1SignedAuthEntryXdr: string,
    player2Address: string,
    player2Points: bigint,
    player2Signer: Pick<contract.ClientOptions, 'signTransaction' | 'signAuthEntry'>,
    authTtlMinutes?: number
  ): Promise<string> {
    const gameParams = this.parseAuthEntry(player1SignedAuthEntryXdr);
    if (player2Address === gameParams.player1) {
      throw new Error('Cannot play against yourself.');
    }

    const buildClient = new DeadDropClient({
      contractId: this.contractId,
      networkPassphrase: NETWORK_PASSPHRASE,
      rpcUrl: RPC_URL,
      publicKey: this.resolveInvokerPublicKey(player2Address),
    });

    const tx = await buildClient.start_game({
      session_id: gameParams.sessionId,
      player1: gameParams.player1,
      player2: player2Address,
      player1_points: gameParams.player1Points,
      player2_points: player2Points,
    }, DEFAULT_METHOD_OPTIONS);

    const validUntilLedgerSeq = await calculateValidUntilLedger(
      RPC_URL, authTtlMinutes ?? MULTI_SIG_AUTH_TTL_MINUTES
    );

    const txWithInjectedAuth = await injectSignedAuthEntry(
      tx,
      player1SignedAuthEntryXdr,
      player2Address,
      player2Signer,
      validUntilLedgerSeq
    );

    const player2Client = this.createSigningClient(player2Address, player2Signer);
    const player2Tx = player2Client.txFromXDR(txWithInjectedAuth.toXDR());
    const needsSigning = await player2Tx.needsNonInvokerSigningBy();
    if (needsSigning.includes(player2Address)) {
      await player2Tx.signAuthEntries({ expiration: validUntilLedgerSeq });
    }

    return player2Tx.toXDR();
  }

  async finalizeStartGame(
    txXdr: string,
    signerAddress: string,
    signer: Pick<contract.ClientOptions, 'signTransaction' | 'signAuthEntry'>,
    authTtlMinutes?: number
  ) {
    const client = this.createSigningClient(signerAddress, signer);
    const tx = client.txFromXDR(txXdr);
    await tx.simulate();
    const validUntilLedgerSeq = await calculateValidUntilLedger(
      RPC_URL, authTtlMinutes ?? DEFAULT_AUTH_TTL_MINUTES
    );
    const sentTx = await signAndSendViaLaunchtube(
      tx,
      DEFAULT_METHOD_OPTIONS.timeoutInSeconds,
      signer,
      validUntilLedgerSeq
    );
    return sentTx.result;
  }

  /**
   * Quick Match: Start a game with both players signing in one flow (dev mode only)
   * This handles the full multi-sig flow without needing to export/import auth entries
   */
  async quickMatchStart(
    sessionId: number,
    player1Address: string,
    player2Address: string,
    player1Signer: Pick<contract.ClientOptions, 'signTransaction' | 'signAuthEntry'>,
    player2Signer: Pick<contract.ClientOptions, 'signTransaction' | 'signAuthEntry'>,
    stakePoints: bigint,
    authTtlMinutes?: number
  ): Promise<void> {
    // Build transaction from player 2's perspective (as the invoker) with signer
    const buildClient = new DeadDropClient({
      contractId: this.contractId,
      networkPassphrase: NETWORK_PASSPHRASE,
      rpcUrl: RPC_URL,
      publicKey: this.resolveInvokerPublicKey(player2Address),
      ...player2Signer,
    });

    const tx = await buildClient.start_game({
      session_id: sessionId,
      player1: player1Address,
      player2: player2Address,
      player1_points: stakePoints,
      player2_points: stakePoints,
    }, DEFAULT_METHOD_OPTIONS);

    if (!tx.simulationData?.result?.auth) {
      throw new Error('No auth entries found in simulation');
    }

    const validUntilLedgerSeq = await calculateValidUntilLedger(
      RPC_URL, authTtlMinutes ?? MULTI_SIG_AUTH_TTL_MINUTES
    );

    // Find and sign Player 1's auth entry
    const authEntries = tx.simulationData.result.auth;
    let player1EntryIndex = -1;

    for (let i = 0; i < authEntries.length; i++) {
      try {
        const entry = authEntries[i];
        const credentialType = entry.credentials().switch().name;

        if (credentialType === 'sorobanCredentialsAddress') {
          const entryAddress = entry.credentials().address().address();
          const entryAddressString = Address.fromScAddress(entryAddress).toString();

          if (entryAddressString === player1Address) {
            player1EntryIndex = i;
            break;
          }
        }
      } catch {
        continue;
      }
    }

    if (player1EntryIndex === -1) {
      throw new Error('Could not find Player 1 auth entry');
    }

    // Sign Player 1's auth entry
    if (!player1Signer.signAuthEntry) {
      throw new Error('Player 1 signAuthEntry function not available');
    }

    const player1SignedEntry = await authorizeEntry(
      authEntries[player1EntryIndex],
      async (preimage) => {
        const signResult = await player1Signer.signAuthEntry!(
          preimage.toXDR('base64'),
          { networkPassphrase: NETWORK_PASSPHRASE, address: player1Address }
        );
        if (signResult.error) throw new Error(`Player 1 sign failed: ${signResult.error.message}`);
        return Buffer.from(signResult.signedAuthEntry, 'base64');
      },
      validUntilLedgerSeq,
      NETWORK_PASSPHRASE,
    );

    // Replace the stub with the signed entry
    authEntries[player1EntryIndex] = player1SignedEntry;
    tx.simulationData.result.auth = authEntries;

    // Now sign and send with player 2 (the invoker - their auth comes from transaction signature)
    const sentTx = await signAndSendViaLaunchtube(
      tx,
      DEFAULT_METHOD_OPTIONS.timeoutInSeconds,
      player2Signer,
      validUntilLedgerSeq
    );

    if (!sentTx.result) {
      throw new Error('Transaction failed');
    }
  }

  // ========================================================================
  // Single-sig lobby actions
  // ========================================================================

  async openGame(
    sessionId: number,
    hostAddress: string,
    hostPoints: bigint,
    signer: Pick<contract.ClientOptions, 'signTransaction' | 'signAuthEntry'>
  ) {
    const client = this.createSigningClient(hostAddress, signer);
    const tx = await client.open_game({
      session_id: sessionId,
      host: hostAddress,
      host_points: hostPoints,
    }, DEFAULT_METHOD_OPTIONS);

    const validUntilLedgerSeq = await calculateValidUntilLedger(RPC_URL, DEFAULT_AUTH_TTL_MINUTES);
    const sentTx = await signAndSendViaLaunchtube(
      tx,
      DEFAULT_METHOD_OPTIONS.timeoutInSeconds,
      signer,
      validUntilLedgerSeq
    );
    this.ensureMutationSubmitted('open_game', sentTx);
    return sentTx;
  }

  async joinGame(
    sessionId: number,
    joinerAddress: string,
    joinerPoints: bigint,
    signer: Pick<contract.ClientOptions, 'signTransaction' | 'signAuthEntry'>
  ) {
    const client = this.createSigningClient(joinerAddress, signer);
    const tx = await client.join_game({
      session_id: sessionId,
      joiner: joinerAddress,
      joiner_points: joinerPoints,
    }, DEFAULT_METHOD_OPTIONS);

    const validUntilLedgerSeq = await calculateValidUntilLedger(RPC_URL, DEFAULT_AUTH_TTL_MINUTES);
    const sentTx = await signAndSendViaLaunchtube(
      tx,
      DEFAULT_METHOD_OPTIONS.timeoutInSeconds,
      signer,
      validUntilLedgerSeq
    );
    return sentTx.result;
  }

  // ========================================================================
  // Single-sig game actions
  // ========================================================================

  async commitSecret(
    sessionId: number,
    playerAddress: string,
    commitment: Buffer,
    signer: Pick<contract.ClientOptions, 'signTransaction' | 'signAuthEntry'>
  ) {
    const client = this.createSigningClient(playerAddress, signer);
    const tx = await client.commit_secret({
      session_id: sessionId,
      player: playerAddress,
      commitment,
    }, DEFAULT_METHOD_OPTIONS);

    const validUntilLedgerSeq = await calculateValidUntilLedger(RPC_URL, DEFAULT_AUTH_TTL_MINUTES);
    const sentTx = await signAndSendViaLaunchtube(
      tx,
      DEFAULT_METHOD_OPTIONS.timeoutInSeconds,
      signer,
      validUntilLedgerSeq
    );
    return sentTx.result;
  }

  async submitPing(
    sessionId: number,
    playerAddress: string,
    turn: number,
    distance: number,
    partialDx: number,
    partialDy: number,
    proof: Buffer,
    publicInputs: Buffer[],
    signer: Pick<contract.ClientOptions, 'signTransaction' | 'signAuthEntry'>
  ) {
    const client = this.createSigningClient(playerAddress, signer);
    const tx = await client.submit_ping({
      session_id: sessionId,
      player: playerAddress,
      turn,
      distance,
      partial_dx: partialDx,
      partial_dy: partialDy,
      proof,
      public_inputs: publicInputs,
    }, DEFAULT_METHOD_OPTIONS);

    const validUntilLedgerSeq = await calculateValidUntilLedger(RPC_URL, DEFAULT_AUTH_TTL_MINUTES);
    try {
      const sentTx = await signAndSendViaLaunchtube(
        tx,
        DEFAULT_METHOD_OPTIONS.timeoutInSeconds,
        signer,
        validUntilLedgerSeq,
      );
      if (sentTx.getTransactionResponse?.status === 'FAILED') {
        throw new Error('Transaction failed');
      }
      return sentTx.result;
    } catch (err) {
      if (err instanceof Error && err.message.includes('Error(Contract, #8)')) {
        throw new Error(
          'Ping proof does not match current on-chain inputs (InvalidPublicInputs). ' +
          'Refresh both players to sync state, then retry Send Ping.'
        );
      }
      if (err instanceof Error && err.message.includes('Transaction failed!')) {
        throw new Error('Transaction failed - check turn order and proof validity');
      }
      throw err;
    }
  }

  async getPingEvents(sessionId: number): Promise<{
    player: string, turn: number, distance: number, x: number, y: number,
  }[]> {
    try {
      const server = new rpc.Server(RPC_URL);
      const latest = await server.getLatestLedger();
      const cursor = this.pingEventsCursorBySession.get(sessionId);
      const startLedger = cursor !== undefined
        ? Math.max(1, cursor - this.pingEventsRewind)
        : Math.max(1, latest.sequence - this.initialPingEventsBackfill);

      // Fetch ALL contract events without topic filter — server-side topic
      // filtering is unreliable on the public testnet RPC. Filter client-side.
      const events = await server.getEvents({
        startLedger,
        filters: [{ type: 'contract', contractIds: [this.contractId] }],
        limit: 200,
      });

      let maxLedgerSeen = startLedger;
      for (const event of events.events) {
        const ledger = Number((event as any).ledger);
        if (Number.isFinite(ledger) && ledger > maxLedgerSeen) {
          maxLedgerSeen = ledger;
        }
      }
      const nextCursor = Math.max(
        maxLedgerSeen + 1,
        latest.sequence - this.pingEventsRewind
      );
      this.pingEventsCursorBySession.set(sessionId, nextCursor);

      // Pre-compute expected topic XDRs for client-side matching
      const expectedSymbol = xdr.ScVal.scvSymbol("ping").toXDR('base64');
      const expectedSessionId = xdr.ScVal.scvU32(sessionId).toXDR('base64');

      return events.events
        .filter(event => {
          try {
            const t = event.topic;
            if (!t || t.length < 2) return false;
            // topic[0] must be Symbol("ping"), topic[1] must be our session_id
            return t[0].toXDR('base64') === expectedSymbol
              && t[1].toXDR('base64') === expectedSessionId;
          } catch { return false; }
        })
        .map(event => {
          try {
            // event.value is already xdr.ScVal (not a base64 wrapper)
            const val = event.value;
            if (val.switch().name !== 'scvVec') return null;
            const vec = val.vec();
            if (!vec || vec.length < 5) return null;

            const player = Address.fromScVal(vec[0]).toString();
            const turn = vec[1].u32();
            const distance = vec[2].u32();
            const x = vec[3].u32();
            const y = vec[4].u32();

            return { player, turn, distance, x, y };
          } catch (e) {
            console.error('Failed to parse ping event', e);
            return null;
          }
        })
        .filter((e): e is { player: string, turn: number, distance: number, x: number, y: number } => e !== null);
    } catch (err) {
      console.error('getPingEvents error:', err);
      return [];
    }
  }

  async forceTimeout(
    sessionId: number,
    playerAddress: string,
    signer: Pick<contract.ClientOptions, 'signTransaction' | 'signAuthEntry'>
  ) {
    const client = this.createSigningClient(playerAddress, signer);
    const tx = await client.force_timeout({
      session_id: sessionId,
      player: playerAddress,
    }, DEFAULT_METHOD_OPTIONS);

    const validUntilLedgerSeq = await calculateValidUntilLedger(RPC_URL, DEFAULT_AUTH_TTL_MINUTES);
    const sentTx = await signAndSendViaLaunchtube(
      tx,
      DEFAULT_METHOD_OPTIONS.timeoutInSeconds,
      signer,
      validUntilLedgerSeq
    );
    return sentTx.result;
  }
}
