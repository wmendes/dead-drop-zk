import { Client as DeadDropClient, type Game, type Lobby } from './bindings';
import {
  NETWORK_PASSPHRASE,
  RPC_URL,
  DEFAULT_METHOD_OPTIONS,
  DEFAULT_AUTH_TTL_MINUTES,
  MULTI_SIG_AUTH_TTL_MINUTES,
  RUNTIME_SIMULATION_SOURCE,
  DEV_PLAYER1_ADDRESS,
  DEAD_DROP_RELAYER_URL,
} from '@/utils/constants';
import { contract, TransactionBuilder, StrKey, xdr, Address, authorizeEntry, rpc } from '@stellar/stellar-sdk';
import { Buffer } from 'buffer';
import { signAndSendViaLaunchtube } from '@/utils/transactionHelper';
import { calculateValidUntilLedger } from '@/utils/ledgerUtils';
import { injectSignedAuthEntry } from '@/utils/authEntryUtils';
import type { ContractSigner } from '@/types/signer';

type ClientOptions = contract.ClientOptions;
type ClientSigner = Pick<contract.ClientOptions, 'signTransaction' | 'signAuthEntry'>;
type MutationSigner = ClientSigner;
const DEAD_DROP_DEBUG = import.meta.env.DEV || import.meta.env.VITE_DEAD_DROP_DEBUG === 'true';

/**
 * Service for interacting with the Dead Drop game contract.
 *
 * Contract methods:
 * - start_game: multi-sig (Player1 + Player2)
 * - submit_ping: single-sig (with ZK proof data)
 * - force_timeout: single-sig
 * - get_game: read-only
 */
export interface DeadDropRandomnessArtifacts {
  randomnessOutput: Buffer;
  dropCommitment: Buffer;
  randomnessSignature: Buffer;
}

export interface SubmitPingResult {
  result: unknown;
  txHash?: string;
  ledger?: number;
}

export interface SubmitPingProofArtifacts {
  proofHex: string;
  publicInputsHex: string[];
}

export interface PingEventRecord {
  player: string;
  turn: number;
  distance: number;
  x: number;
  y: number;
  txHash?: string;
}

export type DeadDropServiceErrorKind =
  | 'invalid_public_inputs'
  | 'proof_verification_failed'
  | 'randomness_verification_failed'
  | 'not_your_turn'
  | 'invalid_turn'
  | 'game_not_found'
  | 'lobby_not_found'
  | 'rpc_stale_read'
  | 'rpc_ledger_range'
  | 'unknown';

export class DeadDropServiceError extends Error {
  kind: DeadDropServiceErrorKind;
  contractCode?: number;
  action?: string;
  latestLedger?: number;
  expectedMinLedger?: number;
  constructor(
    kind: DeadDropServiceErrorKind,
    message: string,
    extras?: Partial<Pick<DeadDropServiceError, 'contractCode' | 'action' | 'latestLedger' | 'expectedMinLedger'>>
  ) {
    super(message);
    this.name = 'DeadDropServiceError';
    this.kind = kind;
    Object.assign(this, extras);
  }
}

type ConsistencyReadOptions = {
  expectedMinLedger?: number;
  maxAttempts?: number;
  delayMs?: number;
};

type MutationClientPlan = {
  client: DeadDropClient;
  bypassRelayer: boolean;
};

export class DeadDropService {
  private baseClient: DeadDropClient;
  private contractId: string;
  private submitPingProofCache = new Map<string, SubmitPingProofArtifacts>();
  private readonly consistencyMaxAttempts = 6;
  private readonly consistencyDelayMs = 700;

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

  private resolveNeutralSimulationSource(): string {
    if (StrKey.isValidEd25519PublicKey(RUNTIME_SIMULATION_SOURCE)) return RUNTIME_SIMULATION_SOURCE;
    if (StrKey.isValidEd25519PublicKey(DEV_PLAYER1_ADDRESS)) return DEV_PLAYER1_ADDRESS;
    throw new Error(
      'Relayer mode requires a neutral simulation source account. Set VITE_SIMULATION_SOURCE_ADDRESS or VITE_DEV_PLAYER1_ADDRESS.'
    );
  }

  private resolveMutationBuildSource(userAddress: string): string {
    const isStdWallet = StrKey.isValidEd25519PublicKey(userAddress);
    if (!DEAD_DROP_RELAYER_URL || !isStdWallet) {
      return this.resolveInvokerPublicKey(userAddress);
    }

    const neutralSource = this.resolveNeutralSimulationSource();
    if (neutralSource === userAddress) {
      throw new Error(
        'Relayer mode cannot build standard-wallet mutations with the user as transaction source. Configure VITE_SIMULATION_SOURCE_ADDRESS to a different funded account.'
      );
    }

    if (DEAD_DROP_DEBUG) {
      console.info('[DeadDropService][mutation-source] Using neutral simulation source for relayer', {
        userAddress,
        buildSource: neutralSource,
      });
    }
    return neutralSource;
  }

  private createSigningClient(
    publicKey: string,
    signer: ClientSigner
  ): DeadDropClient {
    return new DeadDropClient({
      contractId: this.contractId,
      networkPassphrase: NETWORK_PASSPHRASE,
      rpcUrl: RPC_URL,
      publicKey: this.resolveInvokerPublicKey(publicKey),
      ...signer,
    });
  }

  private createMutationSigningClient(
    userAddress: string,
    signer: ClientSigner
  ): DeadDropClient {
    const publicKey = this.resolveMutationBuildSource(userAddress);
    return new DeadDropClient({
      contractId: this.contractId,
      networkPassphrase: NETWORK_PASSPHRASE,
      rpcUrl: RPC_URL,
      publicKey,
      ...signer,
    });
  }

  private planMutationClient(
    userAddress: string,
    signer: ClientSigner
  ): MutationClientPlan {
    const isStdWallet = StrKey.isValidEd25519PublicKey(userAddress);
    if (!DEAD_DROP_RELAYER_URL || !isStdWallet) {
      return {
        client: this.createMutationSigningClient(userAddress, signer),
        bypassRelayer: false,
      };
    }

    try {
      return {
        client: this.createMutationSigningClient(userAddress, signer),
        bypassRelayer: false,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const canFallback =
        message.includes('Relayer mode requires a neutral simulation source account') ||
        message.includes('Relayer mode cannot build standard-wallet mutations with the user as transaction source');
      if (!canFallback) throw err;

      if (DEAD_DROP_DEBUG) {
        console.warn('[DeadDropService][mutation-source] Falling back to direct wallet submission', {
          userAddress,
          reason: message,
        });
      }
      return {
        client: this.createSigningClient(userAddress, signer),
        bypassRelayer: true,
      };
    }
  }

  private toClientSigner(signer: ClientSigner | MutationSigner): ClientSigner {
    return {
      signTransaction: signer.signTransaction,
      signAuthEntry: signer.signAuthEntry,
    };
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

  private async submitMutation(
    action: string,
    tx: contract.AssembledTransaction<unknown>,
    signer: MutationSigner,
    authTtlMinutes: number = DEFAULT_AUTH_TTL_MINUTES,
    submitOptions?: { bypassRelayer?: boolean }
  ): Promise<contract.SentTransaction<any>> {
    if (DEAD_DROP_DEBUG) {
      console.info('[DeadDropService][submitMutation] Begin', {
        action,
        authTtlMinutes,
      });
    }

    const validUntilLedgerSeq = await calculateValidUntilLedger(RPC_URL, authTtlMinutes);
    if (DEAD_DROP_DEBUG) {
      console.info('[DeadDropService][submitMutation] Using relayer/direct signer path', {
        action,
        validUntilLedgerSeq,
      });
    }
    const sentTx = await signAndSendViaLaunchtube(
      tx,
      DEFAULT_METHOD_OPTIONS.timeoutInSeconds,
      this.toClientSigner(signer),
      validUntilLedgerSeq,
      submitOptions
    );
    if (DEAD_DROP_DEBUG) {
      console.info('[DeadDropService][submitMutation] Submit completed', {
        action,
        status: (sentTx as any)?.getTransactionResponse?.status,
        hash: (sentTx as any)?.getTransactionResponse?.hash,
        ledger: (sentTx as any)?.getTransactionResponse?.ledger,
      });
    }
    return sentTx;
  }

  // ========================================================================
  // Read-only
  // ========================================================================

  /**
   * Get game state from backend API (recommended).
   * Backend handles RPC connection stability and caching.
   */
  async getGameStateFromBackend(sessionId: number): Promise<{
    game: Game | null;
    events: PingEventRecord[];
    ledger: number | null;
  }> {
    if (!DEAD_DROP_RELAYER_URL) {
      throw new Error('Backend URL not configured (VITE_DEAD_DROP_RELAYER_URL)');
    }

    try {
      const response = await fetch(
        `${DEAD_DROP_RELAYER_URL}/game/state?session_id=${sessionId}`
      );

      if (!response.ok) {
        throw new Error(`Backend returned ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();
      return {
        game: data.game || null,
        events: data.events || [],
        ledger: data.ledger,
      };
    } catch (err) {
      console.error('[deadDropService] getGameStateFromBackend error:', err);
      throw err;
    }
  }

  /**
   * Get game state directly from RPC (deprecated - use getGameStateFromBackend).
   * Kept for backward compatibility and fallback.
   */
  async getGame(sessionId: number): Promise<Game | null> {
    if (DEAD_DROP_DEBUG) {
      console.warn('[deadDropService] getGame() is deprecated - prefer getGameStateFromBackend()');
    }
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

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private parseLedgerRangeError(err: unknown): { minLedger: number; maxLedger: number } | null {
    const objectMessage =
      typeof err === 'object' && err !== null
        ? (
            ('message' in err && typeof (err as any).message === 'string' && (err as any).message) ||
            ('error' in err && typeof (err as any).error?.message === 'string' && (err as any).error.message) ||
            ('cause' in err && typeof (err as any).cause?.message === 'string' && (err as any).cause.message)
          )
        : null;
    const message = err instanceof Error
      ? err.message
      : objectMessage
        ?? (typeof err === 'string' ? err : (() => {
          try {
            return JSON.stringify(err);
          } catch {
            return String(err);
          }
        })());
    const match = message.match(/startLedger must be within the ledger range:\s*(\d+)\s*-\s*(\d+)/i);
    if (!match) return null;
    return {
      minLedger: Number(match[1]),
      maxLedger: Number(match[2]),
    };
  }

  async getGameWithConsistencyRetry(
    sessionId: number,
    options: ConsistencyReadOptions = {}
  ): Promise<Game | null> {
    const expectedMinLedger = options.expectedMinLedger;
    const maxAttempts = options.maxAttempts ?? this.consistencyMaxAttempts;
    const delayMs = options.delayMs ?? this.consistencyDelayMs;
    const server = new rpc.Server(RPC_URL);

    let lastLatestLedger: number | undefined;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const [latest, game] = await Promise.all([
        server.getLatestLedger().catch(() => null),
        this.getGame(sessionId),
      ]);
      lastLatestLedger = Number(latest?.sequence);
      const staleRead = expectedMinLedger !== undefined
        && Number.isFinite(lastLatestLedger)
        && lastLatestLedger < expectedMinLedger;
      const shouldRetryMissingAfterWrite = expectedMinLedger !== undefined && !game;
      if (!staleRead && !shouldRetryMissingAfterWrite) {
        return game;
      }
      if (DEAD_DROP_DEBUG) {
        console.info('[DeadDropService][getGameWithConsistencyRetry] retry', {
          sessionId,
          attempt,
          maxAttempts,
          latestLedger: lastLatestLedger,
          expectedMinLedger,
          reason: staleRead ? 'stale-ledger' : 'missing-game-after-write',
        });
      }
      if (attempt < maxAttempts) {
        await this.sleep(delayMs);
      }
    }
    if (expectedMinLedger !== undefined) {
      return null;
    }
    throw new DeadDropServiceError(
      'rpc_stale_read',
      'RPC is lagging behind the latest game update. Please retry.',
      { action: 'get_game', latestLedger: lastLatestLedger, expectedMinLedger }
    );
  }

  async getLobbyWithConsistencyRetry(
    sessionId: number,
    options: ConsistencyReadOptions = {}
  ): Promise<Lobby | null> {
    const expectedMinLedger = options.expectedMinLedger;
    const maxAttempts = options.maxAttempts ?? this.consistencyMaxAttempts;
    const delayMs = options.delayMs ?? this.consistencyDelayMs;
    const server = new rpc.Server(RPC_URL);

    let lastLatestLedger: number | undefined;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const [latest, lobby] = await Promise.all([
        server.getLatestLedger().catch(() => null),
        this.getLobby(sessionId),
      ]);
      lastLatestLedger = Number(latest?.sequence);
      const staleRead = expectedMinLedger !== undefined
        && Number.isFinite(lastLatestLedger)
        && lastLatestLedger < expectedMinLedger;
      if (!staleRead) {
        return lobby;
      }
      if (DEAD_DROP_DEBUG) {
        console.info('[DeadDropService][getLobbyWithConsistencyRetry] stale read retry', {
          sessionId,
          attempt,
          maxAttempts,
          latestLedger: lastLatestLedger,
          expectedMinLedger,
        });
      }
      if (attempt < maxAttempts) {
        await this.sleep(delayMs);
      }
    }
    throw new DeadDropServiceError(
      'rpc_stale_read',
      'RPC is lagging behind the latest lobby update. Please retry.',
      { action: 'get_lobby', latestLedger: lastLatestLedger, expectedMinLedger }
    );
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
    randomness: DeadDropRandomnessArtifacts,
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
      randomness_output: randomness.randomnessOutput,
      drop_commitment: randomness.dropCommitment,
      randomness_signature: randomness.randomnessSignature,
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
    randomness: DeadDropRandomnessArtifacts,
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
      randomness_output: randomness.randomnessOutput,
      drop_commitment: randomness.dropCommitment,
      randomness_signature: randomness.randomnessSignature,
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
    randomness: DeadDropRandomnessArtifacts,
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
      randomness_output: randomness.randomnessOutput,
      drop_commitment: randomness.dropCommitment,
      randomness_signature: randomness.randomnessSignature,
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
    signer: MutationSigner
  ) {
    if (DEAD_DROP_DEBUG) {
      console.info('[DeadDropService][open_game] Build start', {
        sessionId,
        hostAddress,
        hostPoints: hostPoints.toString(),
      });
    }
    const mutationPlan = this.planMutationClient(hostAddress, this.toClientSigner(signer));
    const client = mutationPlan.client;
    const tx = await client.open_game({
      session_id: sessionId,
      host: hostAddress,
      host_points: hostPoints,
    }, DEFAULT_METHOD_OPTIONS);
    if (DEAD_DROP_DEBUG) {
      console.info('[DeadDropService][open_game] Build complete', {
        sessionId,
        hasSimulationAuth: Boolean((tx as any)?.simulationData?.result?.auth?.length),
        operationCount: Array.isArray((tx as any)?.built?.operations) ? (tx as any).built.operations.length : undefined,
      });
    }

    const sentTx = await this.submitMutation(
      'open_game',
      tx as contract.AssembledTransaction<unknown>,
      signer,
      DEFAULT_AUTH_TTL_MINUTES,
      { bypassRelayer: mutationPlan.bypassRelayer }
    );
    if (DEAD_DROP_DEBUG) {
      console.info('[DeadDropService][open_game] Submit success', {
        sessionId,
        hash: (sentTx as any)?.getTransactionResponse?.hash,
        status: (sentTx as any)?.getTransactionResponse?.status,
      });
    }
    this.ensureMutationSubmitted('open_game', sentTx);
    return sentTx;
  }

  async joinGame(
    sessionId: number,
    joinerAddress: string,
    joinerPoints: bigint,
    randomness: DeadDropRandomnessArtifacts,
    signer: MutationSigner
  ) {
    if (DEAD_DROP_DEBUG) {
      console.info('[DeadDropService][join_game] Build start', {
        sessionId,
        joinerAddress,
        joinerPoints: joinerPoints.toString(),
        randomnessOutputLength: randomness.randomnessOutput.length,
        dropCommitmentLength: randomness.dropCommitment.length,
        randomnessSignatureLength: randomness.randomnessSignature.length,
        randomnessOutputHex: randomness.randomnessOutput.toString('hex'),
        dropCommitmentHex: randomness.dropCommitment.toString('hex'),
        randomnessSignatureHex: randomness.randomnessSignature.toString('hex'),
      });
    }
    const mutationPlan = this.planMutationClient(joinerAddress, this.toClientSigner(signer));
    const client = mutationPlan.client;
    const tx = await client.join_game({
      session_id: sessionId,
      joiner: joinerAddress,
      joiner_points: joinerPoints,
      randomness_output: randomness.randomnessOutput,
      drop_commitment: randomness.dropCommitment,
      randomness_signature: randomness.randomnessSignature,
    }, DEFAULT_METHOD_OPTIONS);
    if (DEAD_DROP_DEBUG) {
      console.info('[DeadDropService][join_game] Build complete', {
        sessionId,
        hasSimulationAuth: Boolean((tx as any)?.simulationData?.result?.auth?.length),
        operationCount: Array.isArray((tx as any)?.built?.operations) ? (tx as any).built.operations.length : undefined,
      });
    }

    try {
      if (DEAD_DROP_DEBUG) {
        console.info('[DeadDropService][join_game] Submitting join_game', { sessionId, joinerAddress });
      }
      const sentTx = await this.submitMutation(
        'join_game',
        tx as contract.AssembledTransaction<unknown>,
        signer,
        DEFAULT_AUTH_TTL_MINUTES,
        { bypassRelayer: mutationPlan.bypassRelayer }
      );
      if (DEAD_DROP_DEBUG) {
        console.info('[DeadDropService][join_game] Submit success', {
          sessionId,
          status: (sentTx as any)?.getTransactionResponse?.status,
          hash: (sentTx as any)?.getTransactionResponse?.hash,
          ledger: (sentTx as any)?.getTransactionResponse?.ledger,
        });
      }
      return sentTx;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (DEAD_DROP_DEBUG) {
        console.error('[DeadDropService][join_game] Submit failed', {
          sessionId,
          joinerAddress,
          error: err,
          message: msg,
        });
      }
      if (msg.includes('Error(Contract, #17)')) {
        throw new DeadDropServiceError(
          'randomness_verification_failed',
          'Dead Drop randomness verification failed (Error #17). ' +
          'Check prover output and deployed randomness verifier compatibility.',
          { contractCode: 17, action: 'join_game' }
        );
      }
      if (
        msg.includes('MismatchingParameterLen')
        || msg.includes('UnexpectedSize')
      ) {
        throw new Error(
          'Dead Drop contract ABI mismatch: the deployed contract appears outdated. ' +
          'Redeploy dead-drop + mock-verifier and update VITE_DEAD_DROP_CONTRACT_ID.'
        );
      }
      throw err;
    }
  }

  // ========================================================================
  // Single-sig game actions
  // ========================================================================

  async submitPing(
    sessionId: number,
    playerAddress: string,
    turn: number,
    distance: number,
    pingX: number,
    pingY: number,
    proof: Buffer,
    publicInputs: Buffer[],
    signer: MutationSigner
  ): Promise<SubmitPingResult> {
    const mutationPlan = this.planMutationClient(playerAddress, this.toClientSigner(signer));
    const client = mutationPlan.client;
    const tx = await client.submit_ping({
      session_id: sessionId,
      player: playerAddress,
      turn,
      distance,
      ping_x: pingX,
      ping_y: pingY,
      proof,
      public_inputs: publicInputs,
    }, DEFAULT_METHOD_OPTIONS);

    try {
      const sentTx = await this.submitMutation(
        'submit_ping',
        tx as contract.AssembledTransaction<unknown>,
        signer,
        DEFAULT_AUTH_TTL_MINUTES,
        { bypassRelayer: mutationPlan.bypassRelayer }
      );
      if (sentTx.getTransactionResponse?.status === 'FAILED') {
        throw new Error('Transaction failed');
      }
      const txHash = (sentTx as any)?.getTransactionResponse?.hash as string | undefined;
      const ledger = (sentTx as any)?.getTransactionResponse?.ledger as number | undefined;
      return {
        result: sentTx.result,
        txHash,
        ledger,
      };
    } catch (err) {
      if (err instanceof Error && err.message.includes('Error(Contract, #8)')) {
        throw new DeadDropServiceError(
          'invalid_public_inputs',
          'Ping proof does not match current on-chain inputs (InvalidPublicInputs). ' +
          'Refresh both players to sync state, then retry Send Ping.',
          { contractCode: 8, action: 'submit_ping' }
        );
      }
      if (err instanceof Error && err.message.includes('Error(Contract, #10)')) {
        throw new DeadDropServiceError(
          'proof_verification_failed',
          'Proof verifier rejected the proof (ProofVerificationFailed). Check prover/verifier compatibility.',
          { contractCode: 10, action: 'submit_ping' }
        );
      }
      if (err instanceof Error && err.message.includes('Error(Contract, #6)')) {
        throw new DeadDropServiceError('not_your_turn', 'It is no longer your turn.', { contractCode: 6, action: 'submit_ping' });
      }
      if (err instanceof Error && err.message.includes('Error(Contract, #7)')) {
        throw new DeadDropServiceError('invalid_turn', 'Turn changed before submission.', { contractCode: 7, action: 'submit_ping' });
      }
      if (err instanceof Error && err.message.includes('Transaction failed!')) {
        throw new Error('Transaction failed - check turn order and proof validity');
      }
      throw err;
    }
  }

  private extractOperationsFromEnvelope(envelope: xdr.TransactionEnvelope): xdr.Operation[] {
    const envelopeType = envelope.switch().name;
    if (envelopeType === 'envelopeTypeTx') {
      return envelope.v1().tx().operations();
    }
    if (envelopeType === 'envelopeTypeTxV0') {
      return envelope.v0().tx().operations();
    }
    if (envelopeType === 'envelopeTypeTxFeeBump') {
      const inner = envelope.feeBump().tx().innerTx();
      const innerAny = inner as any;
      const innerType = inner.switch().name;
      if (innerType === 'envelopeTypeTx' && typeof innerAny.v1 === 'function') {
        return innerAny.v1().tx().operations();
      }
      if (innerType === 'envelopeTypeTxV0' && typeof innerAny.v0 === 'function') {
        return innerAny.v0().tx().operations();
      }
      if (typeof innerAny.v1 === 'function') {
        return innerAny.v1().tx().operations();
      }
      return [];
    }
    return [];
  }

  private decodeSubmitPingProofFromEnvelope(
    envelope: xdr.TransactionEnvelope
  ): SubmitPingProofArtifacts | null {
    const operations = this.extractOperationsFromEnvelope(envelope);
    for (const operation of operations) {
      const body = operation.body();
      if (body.switch().name !== 'invokeHostFunction') continue;

      const invokeHostFn = body.invokeHostFunctionOp();
      const hostFunction = invokeHostFn.hostFunction();
      if (hostFunction.switch().name !== 'hostFunctionTypeInvokeContract') continue;

      const invokeContract = hostFunction.invokeContract();
      const fnNameRaw = invokeContract.functionName();
      const functionName = typeof fnNameRaw === 'string'
        ? fnNameRaw
        : Buffer.from(fnNameRaw).toString('utf-8');
      if (functionName !== 'submit_ping') continue;

      const args = invokeContract.args();
      if (args.length < 8) return null;

      const proofArg = args[6];
      const publicInputsArg = args[7];
      if (proofArg.switch().name !== 'scvBytes') return null;
      if (publicInputsArg.switch().name !== 'scvVec') return null;

      const publicInputs = publicInputsArg.vec();
      if (!publicInputs) return null;

      const proofHex = proofArg.bytes().toString('hex');
      const publicInputsHex: string[] = [];
      for (const input of publicInputs) {
        if (input.switch().name !== 'scvBytes') return null;
        publicInputsHex.push(input.bytes().toString('hex'));
      }

      return { proofHex, publicInputsHex };
    }

    return null;
  }

  private normalizeTxHash(txHash: string): string {
    return txHash.trim().replace(/^0x/i, '').toLowerCase();
  }


  async getSubmitPingProofFromTx(txHash: string): Promise<SubmitPingProofArtifacts | null> {
    const normalizedHash = this.normalizeTxHash(txHash);
    if (!/^[0-9a-f]{64}$/.test(normalizedHash)) {
      console.warn('getSubmitPingProofFromTx: invalid transaction hash:', txHash);
      return null;
    }

    if (this.submitPingProofCache.has(normalizedHash)) {
      return this.submitPingProofCache.get(normalizedHash) ?? null;
    }

    try {
      const server = new rpc.Server(RPC_URL);
      const maxAttempts = 4;
      const waitMs = (attempt: number) => 800 * (attempt + 1);
      const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

      let txInfo: any = null;
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        txInfo = await server.getTransaction(normalizedHash);
        const status = String(txInfo?.status || '');
        if (status === 'SUCCESS') break;
        if (status === 'NOT_FOUND' && attempt < maxAttempts - 1) {
          await sleep(waitMs(attempt));
          continue;
        }
        return null;
      }

      if (String(txInfo?.status || '') !== 'SUCCESS') {
        return null;
      }

      const envelopeXdr = txInfo?.envelopeXdr;
      if (!envelopeXdr) {
        return null;
      }

      const envelope = typeof envelopeXdr === 'string'
        ? xdr.TransactionEnvelope.fromXDR(envelopeXdr, 'base64')
        : envelopeXdr;
      const decoded = this.decodeSubmitPingProofFromEnvelope(envelope);
      if (decoded) {
        this.submitPingProofCache.set(normalizedHash, decoded);
      }
      return decoded;
    } catch (err) {
      console.warn('getSubmitPingProofFromTx decode failed:', err);
      return null;
    }
  }

  async getPingEvents(sessionId: number): Promise<PingEventRecord[]> {
    // Use backend event indexer instead of polling RPC directly
    // This eliminates all cursor management issues
    const relayerUrl = DEAD_DROP_RELAYER_URL || 'http://localhost:8787';

    try {
      const response = await fetch(
        `${relayerUrl}/events/ping?session_id=${sessionId}`
      );

      if (!response.ok) {
        if (DEAD_DROP_DEBUG) {
          console.warn('[DeadDropService][getPingEvents] Backend fetch failed:', response.statusText);
        }
        return [];
      }

      const { events } = await response.json();
      return events || [];
    } catch (error) {
      if (DEAD_DROP_DEBUG) {
        console.error('[DeadDropService][getPingEvents] Backend fetch error:', error);
      }
      return []; // Graceful degradation
    }
  }

  async forceTimeout(
    sessionId: number,
    playerAddress: string,
    signer: MutationSigner
  ) {
    const mutationPlan = this.planMutationClient(playerAddress, this.toClientSigner(signer));
    const client = mutationPlan.client;
    const tx = await client.force_timeout({
      session_id: sessionId,
      player: playerAddress,
    }, DEFAULT_METHOD_OPTIONS);

    const sentTx = await this.submitMutation(
      'force_timeout',
      tx as contract.AssembledTransaction<unknown>,
      signer,
      DEFAULT_AUTH_TTL_MINUTES,
      { bypassRelayer: mutationPlan.bypassRelayer }
    );
    return sentTx.result;
  }
}
