#!/usr/bin/env bun

import { createHash, randomBytes } from 'crypto';
import { Buffer } from 'buffer';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { mkdir, writeFile } from 'fs/promises';
import path from 'path';
import { Keypair, TransactionBuilder, hash as stellarHash, type xdr } from '@stellar/stellar-sdk';
import { Client as DeadDropClient, GameStatus, type Game, Errors } from '../bindings/dead_drop/src/index';
import { readEnvFile, getEnvValue } from './utils/env';

type CliArgs = {
  sessionId?: number;
  newSession: boolean;
  pingX?: number;
  pingY?: number;
  player: 1 | 2;
  turn?: number;
  proverUrl?: string;
  rpcUrl?: string;
  contractId?: string;
  networkPassphrase?: string;
  verifierContractId?: string;
  verifierSourceAccount?: string;
  hostPoints?: string;
  joinerPoints?: string;
  bootstrapOnly: boolean;
  sessionSeed?: string;
  maxSessionIdAttempts: number;
  repeat: number;
  delayBeforeSubmitMs: number;
  skipSubmit: boolean;
  dumpProofArtifacts: boolean;
  json: boolean;
};

type PhaseTiming = { startedAtMs: number; endedAtMs: number; durationMs: number };

type PublicInputComparison = {
  expected: {
    sessionId: number;
    turn: number;
    pingX: number;
    pingY: number;
    dropCommitmentHex: string | null;
    distance: number;
  };
  actual: {
    sessionId: number | null;
    turn: number | null;
    pingX: number | null;
    pingY: number | null;
    dropCommitmentHex: string | null;
    distance: number | null;
  };
  matches: Record<string, boolean>;
  pass: boolean;
};

type RunReport = {
  runIndex: number;
  config: Record<string, unknown>;
  signer: { player: 1 | 2; publicKey: string };
  timings: Record<string, PhaseTiming>;
  preState: any;
  preSubmitState: any;
  postState: any;
  bootstrap: any;
  prover: any;
  comparison: PublicInputComparison | null;
  flags: {
    turnChangedBeforeSubmit: boolean;
    preSubmitTurn: number | null;
    requestedTurn: number | null;
  };
  submit: any;
  directVerifier: any;
  ok: boolean;
};

const execFileAsync = promisify(execFile);

function usage() {
  console.log(`Usage:
  bun scripts/test-dead-drop-proof-flow.ts (--session <id> | --new-session) [--ping-x <0..99> --ping-y <0..99>] [options]

Options:
  --new-session                   Create a fresh session (open + randomness + join) before testing
  --player <1|2>                  Dev player to sign submit_ping (default: 1)
  --turn <u32>                    Override turn (default: current on-chain turn)
  --host-points <i128>            Host points when using --new-session (default: 100)
  --joiner-points <i128>          Joiner points when using --new-session (default: 100)
  --bootstrap-only                In --new-session mode, create/open/join then exit without proof test
  --session-seed <string>         Deterministic seed for session ID generation (optional)
  --max-session-id-attempts <n>   Session ID collision retries for --new-session (default: 10)
  --repeat <n>                    Repeat identical diagnostic runs (default: 1)
  --delay-before-submit-ms <n>    Sleep before submit to simulate race (default: 0)
  --skip-submit                   Stop after prover + verifier diagnostics (do not call submit_ping)
  --dump-proof-artifacts          Save proof/public artifact bundle to scripts/.debug/dead-drop/
  --prover-url <url>              Override prover URL
  --rpc-url <url>                 Override RPC URL
  --contract-id <id>              Override dead-drop contract ID
  --verifier-contract-id <id>     Override real Groth16 verifier contract ID (direct verify diagnostic)
  --verifier-source-account <id>  Stellar CLI identity/source for direct verifier invoke (default: alice)
  --network-passphrase <str>      Override network passphrase
  --json                          Emit JSON report per run
  --help                          Show this help
`);
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    newSession: false,
    player: 1,
    bootstrapOnly: false,
    maxSessionIdAttempts: 10,
    repeat: 1,
    delayBeforeSubmitMs: 0,
    skipSubmit: false,
    dumpProofArtifacts: false,
    json: false,
  };

  const nextValue = (i: number): string => {
    const v = argv[i + 1];
    if (!v || v.startsWith('--')) throw new Error(`Missing value for ${argv[i]}`);
    return v;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    switch (a) {
      case '--help':
        usage();
        process.exit(0);
      case '--session':
        args.sessionId = Number(nextValue(i)); i += 1; break;
      case '--new-session':
        args.newSession = true; break;
      case '--ping-x':
        args.pingX = Number(nextValue(i)); i += 1; break;
      case '--ping-y':
        args.pingY = Number(nextValue(i)); i += 1; break;
      case '--player':
        args.player = Number(nextValue(i)) === 2 ? 2 : 1; i += 1; break;
      case '--turn':
        args.turn = Number(nextValue(i)); i += 1; break;
      case '--host-points':
        args.hostPoints = nextValue(i); i += 1; break;
      case '--joiner-points':
        args.joinerPoints = nextValue(i); i += 1; break;
      case '--bootstrap-only':
        args.bootstrapOnly = true; break;
      case '--session-seed':
        args.sessionSeed = nextValue(i); i += 1; break;
      case '--max-session-id-attempts':
        args.maxSessionIdAttempts = Number(nextValue(i)); i += 1; break;
      case '--repeat':
        args.repeat = Number(nextValue(i)); i += 1; break;
      case '--delay-before-submit-ms':
        args.delayBeforeSubmitMs = Number(nextValue(i)); i += 1; break;
      case '--skip-submit':
        args.skipSubmit = true; break;
      case '--dump-proof-artifacts':
        args.dumpProofArtifacts = true; break;
      case '--prover-url':
        args.proverUrl = nextValue(i); i += 1; break;
      case '--rpc-url':
        args.rpcUrl = nextValue(i); i += 1; break;
      case '--contract-id':
        args.contractId = nextValue(i); i += 1; break;
      case '--verifier-contract-id':
        args.verifierContractId = nextValue(i); i += 1; break;
      case '--verifier-source-account':
        args.verifierSourceAccount = nextValue(i); i += 1; break;
      case '--network-passphrase':
        args.networkPassphrase = nextValue(i); i += 1; break;
      case '--json':
        args.json = true; break;
      default:
        throw new Error(`Unknown argument: ${a}`);
    }
  }

  return args;
}

function assertU32(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new Error(`${label} must be a valid u32`);
  }
  return value;
}

function assertI128String(value: string | undefined, label: string, fallback: string): bigint {
  const raw = value ?? fallback;
  if (!/^-?\d+$/.test(raw)) {
    throw new Error(`${label} must be a valid integer string`);
  }
  return BigInt(raw);
}

function assertGridCoord(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0 || value > 99) {
    throw new Error(`${label} must be an integer in range 0..99`);
  }
  return value;
}

function normalizeHex(value: string): string {
  return value.replace(/^0x/i, '').toLowerCase();
}

function shortHex(value: string, size = 8): string {
  const h = normalizeHex(value);
  if (h.length <= size * 2) return h;
  return `${h.slice(0, size)}...${h.slice(-size)}`;
}

function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function proofFingerprintHex(proofHex: string): string {
  return sha256Hex(Buffer.from(normalizeHex(proofHex), 'hex'));
}

async function maybeDumpProofArtifacts(opts: {
  enabled: boolean;
  runIndex: number;
  sessionId: number;
  requestedTurn: number;
  pingX: number;
  pingY: number;
  proofHex: string;
  publicInputsHex: string[];
  report: RunReport;
}) {
  if (!opts.enabled) return null;
  const outDir = path.join(process.cwd(), 'scripts', '.debug', 'dead-drop');
  await mkdir(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = `proof-flow-session-${opts.sessionId}-run-${opts.runIndex}-${stamp}`;

  const proofBytesHex = normalizeHex(opts.proofHex);
  const pubSignalsBytesHex = encodePublicSignalsBytesHex(opts.publicInputsHex);
  const publicSignalsDecimal = opts.publicInputsHex.map((h) => BigInt(`0x${normalizeHex(h)}`).toString(10));

  const rawJsonPath = path.join(outDir, `${base}.json`);
  const publicJsonPath = path.join(outDir, `${base}.public.json`);
  const proofHexPath = path.join(outDir, `${base}.proof.hex`);
  const pubSignalsHexPath = path.join(outDir, `${base}.pubsignals.hex`);

  const bundle = {
    sessionId: opts.sessionId,
    requestedTurn: opts.requestedTurn,
    pingX: opts.pingX,
    pingY: opts.pingY,
    generatedAt: new Date().toISOString(),
    onChain: {
      preState: opts.report.preState,
      preSubmitState: opts.report.preSubmitState,
    },
    prover: opts.report.prover,
    comparison: opts.report.comparison,
    directVerifier: opts.report.directVerifier,
    proof: {
      proofHex: proofBytesHex,
      proofBytesLength: proofBytesHex.length / 2,
      proofSha256: sha256Hex(Buffer.from(proofBytesHex, 'hex')),
    },
    publicSignals: {
      fieldHex: opts.publicInputsHex.map((h) => normalizeHex(h)),
      fieldDecimal: publicSignalsDecimal,
      encodedBytesHex: pubSignalsBytesHex,
      encodedBytesLength: pubSignalsBytesHex.length / 2,
      encodedBytesSha256: sha256Hex(Buffer.from(pubSignalsBytesHex, 'hex')),
    },
  };

  await Promise.all([
    writeFile(rawJsonPath, JSON.stringify(bundle, null, 2)),
    writeFile(publicJsonPath, JSON.stringify(publicSignalsDecimal, null, 2)),
    writeFile(proofHexPath, `${proofBytesHex}\n`),
    writeFile(pubSignalsHexPath, `${pubSignalsBytesHex}\n`),
  ]);

  return { outDir, rawJsonPath, publicJsonPath, proofHexPath, pubSignalsHexPath };
}

function decodeU32Field(hexField: string): number {
  const b = Buffer.from(normalizeHex(hexField), 'hex');
  if (b.length !== 32) throw new Error(`Expected 32-byte field element, got ${b.length}`);
  const n = BigInt(`0x${b.toString('hex')}`);
  if (n > 0xffffffffn) throw new Error(`Field element out of u32 range: ${hexField}`);
  return Number(n);
}

function decodePublicInputComparison(params: {
  publicInputsHex: string[];
  requestedSessionId: number;
  requestedTurn: number;
  pingX: number;
  pingY: number;
  proverDistance: number;
  onChainDropCommitmentHex: string | null;
}): PublicInputComparison {
  const normalized = params.publicInputsHex.map(normalizeHex);
  const actual = {
    sessionId: null as number | null,
    turn: null as number | null,
    pingX: null as number | null,
    pingY: null as number | null,
    dropCommitmentHex: null as string | null,
    distance: null as number | null,
  };

  try { actual.sessionId = decodeU32Field(normalized[0]); } catch {}
  try { actual.turn = decodeU32Field(normalized[1]); } catch {}
  try { actual.pingX = decodeU32Field(normalized[2]); } catch {}
  try { actual.pingY = decodeU32Field(normalized[3]); } catch {}
  actual.dropCommitmentHex = normalized[4] ?? null;
  try { actual.distance = decodeU32Field(normalized[5]); } catch {}

  const expected = {
    sessionId: params.requestedSessionId,
    turn: params.requestedTurn,
    pingX: params.pingX,
    pingY: params.pingY,
    dropCommitmentHex: params.onChainDropCommitmentHex,
    distance: params.proverDistance,
  };

  const matches = {
    sessionId: actual.sessionId === expected.sessionId,
    turn: actual.turn === expected.turn,
    pingX: actual.pingX === expected.pingX,
    pingY: actual.pingY === expected.pingY,
    dropCommitment: actual.dropCommitmentHex === (expected.dropCommitmentHex ? normalizeHex(expected.dropCommitmentHex) : null),
    distance: actual.distance === expected.distance,
    count: normalized.length === 6,
  };

  return {
    expected,
    actual,
    matches,
    pass: Object.values(matches).every(Boolean),
  };
}

async function readJsonOrText(response: Response): Promise<any> {
  const text = await response.text();
  try { return JSON.parse(text); } catch { return text; }
}

async function callProver(proverUrl: string, req: { sessionId: number; turn: number; pingX: number; pingY: number }) {
  const url = `${proverUrl.replace(/\/$/, '')}/prove/ping`;
  const started = Date.now();
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      session_id: req.sessionId,
      turn: req.turn,
      ping_x: req.pingX,
      ping_y: req.pingY,
    }),
  });
  const body = await readJsonOrText(response);
  const ended = Date.now();
  return { response, body, timing: timingFrom(started, ended), url };
}

async function initSessionRandomness(proverUrl: string, sessionId: number) {
  const url = `${proverUrl.replace(/\/$/, '')}/randomness/session`;
  const started = Date.now();
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session_id: sessionId }),
  });
  const body = await readJsonOrText(response);
  const ended = Date.now();
  return { response, body, timing: timingFrom(started, ended), url };
}

function encodePublicSignalsBytesHex(publicInputsHex: string[]): string {
  const normalized = publicInputsHex.map((h) => normalizeHex(h));
  const out = Buffer.alloc(4 + normalized.length * 32);
  out.writeUInt32BE(normalized.length, 0);
  normalized.forEach((h, i) => {
    const b = Buffer.from(h, 'hex');
    if (b.length !== 32) throw new Error(`Invalid public input byte length at index ${i}`);
    b.copy(out, 4 + i * 32);
  });
  return out.toString('hex');
}

async function runDirectVerifierCheck(params: {
  verifierContractId: string;
  verifierSourceAccount: string;
  proofHex: string;
  publicInputsHex: string[];
}) {
  const proofBytesHex = normalizeHex(params.proofHex);
  const publicSignalsBytesHex = encodePublicSignalsBytesHex(params.publicInputsHex);
  const started = Date.now();
  try {
    const { stdout, stderr } = await execFileAsync('stellar', [
      'contract', 'invoke',
      '--id', params.verifierContractId,
      '--source-account', params.verifierSourceAccount,
      '--network', 'testnet',
      '--',
      'verify',
      '--proof-bytes', proofBytesHex,
      '--pub-signals-bytes', publicSignalsBytesHex,
    ], { maxBuffer: 2 * 1024 * 1024 });
    const ended = Date.now();
    return {
      ok: true,
      timing: timingFrom(started, ended),
      stdout: stdout.trim(),
      stderr: stderr.trim(),
      proofBytesLength: proofBytesHex.length / 2,
      publicSignalsBytesLength: publicSignalsBytesHex.length / 2,
    };
  } catch (error: any) {
    const ended = Date.now();
    return {
      ok: false,
      timing: timingFrom(started, ended),
      error: String(error?.message ?? error),
      stdout: String(error?.stdout ?? '').trim(),
      stderr: String(error?.stderr ?? '').trim(),
      proofBytesLength: proofBytesHex.length / 2,
      publicSignalsBytesLength: publicSignalsBytesHex.length / 2,
    };
  }
}

function timingFrom(startedAtMs: number, endedAtMs: number): PhaseTiming {
  return { startedAtMs, endedAtMs, durationMs: endedAtMs - startedAtMs };
}

function logStep(message: string, data?: unknown) {
  const ts = new Date().toISOString();
  if (data === undefined) {
    console.log(`[${ts}] ${message}`);
  } else {
    console.log(`[${ts}] ${message}`, data);
  }
}

function summarizeGame(game: Game | null) {
  if (!game) return null;
  const winner = (game.winner as any);
  const winnerValue = winner && typeof winner === 'object' && 'unwrap' in winner
    ? (winner.isSome?.() ? winner.unwrap() : null)
    : winner;
  return {
    status: game.status,
    statusName: GameStatus[game.status],
    current_turn: game.current_turn,
    whose_turn: game.whose_turn,
    player1: game.player1,
    player2: game.player2,
    player1_best_distance: game.player1_best_distance,
    player2_best_distance: game.player2_best_distance,
    drop_commitment_hex: Buffer.from(game.drop_commitment).toString('hex'),
    winner: winnerValue ?? null,
    last_action_ledger: game.last_action_ledger,
  };
}

async function simulateRead<T>(txPromise: Promise<any>): Promise<T | null> {
  const tx = await txPromise;
  const result = await tx.simulate();
  if (result.result?.isOk?.()) return result.result.unwrap() as T;
  return null;
}

function createDevSigner(secret: string) {
  const kp = Keypair.fromSecret(secret);
  const publicKey = kp.publicKey();
  return {
    publicKey,
    signTransaction: async (txXdr: string, opts?: { networkPassphrase?: string }) => {
      try {
        if (!opts?.networkPassphrase) throw new Error('Missing networkPassphrase');
        const tx = TransactionBuilder.fromXDR(txXdr, opts.networkPassphrase);
        tx.sign(kp);
        return { signedTxXdr: tx.toXDR(), signerAddress: publicKey };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { signedTxXdr: txXdr, signerAddress: publicKey, error: { code: -1, message } };
      }
    },
    signAuthEntry: async (preimageXdr: string) => {
      try {
        const preimageBytes = Buffer.from(preimageXdr, 'base64');
        const payload = stellarHash(preimageBytes);
        const signatureBytes = kp.sign(payload);
        return {
          signedAuthEntry: Buffer.from(signatureBytes).toString('base64'),
          signerAddress: publicKey,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { signedAuthEntry: preimageXdr, signerAddress: publicKey, error: { code: -1, message } };
      }
    },
  };
}

function parseContractError(raw: unknown) {
  const message = raw instanceof Error ? raw.message : String(raw);
  const match = message.match(/Error\(Contract,\s*#(\d+)\)/);
  const code = match ? Number(match[1]) : null;
  const known = code !== null ? (Errors as Record<number, { message: string }>)[code] : undefined;
  return {
    rawMessage: message,
    contractCode: code,
    contractErrorName: known?.message ?? null,
    classification:
      code === 8 ? 'InvalidPublicInputs' :
      code === 7 ? 'InvalidTurn' :
      code === 6 ? 'NotYourTurn' :
      code === 10 ? 'ProofVerificationFailed' :
      code === 12 ? 'InvalidDistance' :
      null,
  };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForActiveGame(readClient: DeadDropClient, sessionId: number, maxAttempts = 8, delayMs = 700) {
  let last: ReturnType<typeof summarizeGame> | null = null;
  for (let i = 0; i < maxAttempts; i += 1) {
    const game = await simulateRead<Game>(readClient.get_game({ session_id: sessionId }));
    last = summarizeGame(game);
    if (last?.statusName === 'Active') return { game: last, attempts: i + 1 };
    if (i < maxAttempts - 1) await sleep(delayMs);
  }
  return { game: last, attempts: maxAttempts };
}

async function signAndSendMutation(txPromise: Promise<any>) {
  const tx = await txPromise;
  const simulated = await tx.simulate();
  return simulated.signAndSend();
}

function generateSessionIdCandidate(seed: string | undefined, attempt: number): number {
  if (seed) {
    const digest = createHash('sha256').update(`${seed}:${attempt}`).digest();
    const n = digest.readUInt32BE(0);
    return n === 0 ? 1 : n;
  }
  let n = randomBytes(4).readUInt32BE(0);
  if (n === 0) n = 1;
  return n;
}

async function findFreeSessionId(readClient: DeadDropClient, opts: { seed?: string; maxAttempts: number }) {
  const attempts: Array<{ sessionId: number; gameExists: boolean; lobbyExists: boolean }> = [];
  for (let i = 0; i < opts.maxAttempts; i += 1) {
    const candidate = generateSessionIdCandidate(opts.seed, i);
    const [game, lobby] = await Promise.all([
      simulateRead<Game>(readClient.get_game({ session_id: candidate })),
      simulateRead<any>(readClient.get_lobby({ session_id: candidate })),
    ]);
    const gameExists = Boolean(game);
    const lobbyExists = Boolean(lobby);
    attempts.push({ sessionId: candidate, gameExists, lobbyExists });
    if (!gameExists && !lobbyExists) {
      return { sessionId: candidate, attempts };
    }
  }
  throw new Error(`Failed to find free session ID after ${opts.maxAttempts} attempts`);
}

async function main() {
  const cli = parseArgs(process.argv.slice(2));
  const env = {
    ...(await readEnvFile('.env')),
    ...process.env,
  } as Record<string, string>;

  if (cli.newSession && cli.sessionId !== undefined) {
    throw new Error('Use either --session or --new-session, not both');
  }
  if (!cli.newSession && cli.sessionId === undefined) {
    throw new Error('Specify --session <id> or --new-session');
  }

  const sessionIdFromCli = cli.sessionId !== undefined ? assertU32(cli.sessionId, 'session') : undefined;
  const pingX = cli.bootstrapOnly ? undefined : assertGridCoord(cli.pingX ?? NaN, 'ping-x');
  const pingY = cli.bootstrapOnly ? undefined : assertGridCoord(cli.pingY ?? NaN, 'ping-y');
  const repeat = Number.isInteger(cli.repeat) && cli.repeat > 0 ? cli.repeat : 1;
  const delayBeforeSubmitMs = Number.isFinite(cli.delayBeforeSubmitMs) && cli.delayBeforeSubmitMs >= 0
    ? cli.delayBeforeSubmitMs
    : 0;
  const hostPoints = assertI128String(cli.hostPoints, 'host-points', '100');
  const joinerPoints = assertI128String(cli.joinerPoints, 'joiner-points', '100');
  const maxSessionIdAttempts = Number.isInteger(cli.maxSessionIdAttempts) && cli.maxSessionIdAttempts > 0
    ? cli.maxSessionIdAttempts
    : 10;

  const rpcUrl = cli.rpcUrl || getEnvValue(env, 'VITE_SOROBAN_RPC_URL');
  const contractId = cli.contractId || getEnvValue(env, 'VITE_DEAD_DROP_CONTRACT_ID');
  const proverUrl = cli.proverUrl || getEnvValue(env, 'VITE_DEAD_DROP_PROVER_URL');
  const verifierContractId = cli.verifierContractId
    || getEnvValue(env, 'VITE_DEAD_DROP_VERIFIER_CONTRACT_ID', getEnvValue(env, 'DEAD_DROP_VERIFIER_CONTRACT_ID', ''));
  const verifierSourceAccount = cli.verifierSourceAccount || 'alice';
  const networkPassphrase = cli.networkPassphrase || getEnvValue(env, 'VITE_NETWORK_PASSPHRASE');
  const player1Secret = getEnvValue(env, 'VITE_DEV_PLAYER1_SECRET');
  const player2Secret = getEnvValue(env, 'VITE_DEV_PLAYER2_SECRET');
  const activeSecret = cli.player === 2 ? player2Secret : player1Secret;

  if (!rpcUrl) throw new Error('Missing VITE_SOROBAN_RPC_URL');
  if (!contractId) throw new Error('Missing VITE_DEAD_DROP_CONTRACT_ID');
  if (!proverUrl) throw new Error('Missing VITE_DEAD_DROP_PROVER_URL');
  if (!networkPassphrase) throw new Error('Missing VITE_NETWORK_PASSPHRASE');
  if (!player1Secret) throw new Error('Missing VITE_DEV_PLAYER1_SECRET');
  if (!player2Secret) throw new Error('Missing VITE_DEV_PLAYER2_SECRET');
  if (!activeSecret) throw new Error(`Missing VITE_DEV_PLAYER${cli.player}_SECRET`);

  const player1Signer = createDevSigner(player1Secret);
  const player2Signer = createDevSigner(player2Secret);
  const signer = cli.player === 2 ? player2Signer : player1Signer;

  const baseReadClient = new DeadDropClient({
    contractId,
    rpcUrl,
    networkPassphrase,
    publicKey: signer.publicKey,
  });

  let effectiveSessionId = sessionIdFromCli ?? null;
  let bootstrapSummary: any = null;

  if (cli.newSession) {
    logStep('Bootstrapping fresh Dead Drop session', {
      host: player1Signer.publicKey,
      joiner: player2Signer.publicKey,
      hostPoints: hostPoints.toString(),
      joinerPoints: joinerPoints.toString(),
      sessionSeed: cli.sessionSeed ?? null,
      maxSessionIdAttempts,
    });

    const sessionPick = await findFreeSessionId(baseReadClient, {
      seed: cli.sessionSeed,
      maxAttempts: maxSessionIdAttempts,
    });
    effectiveSessionId = sessionPick.sessionId;
    logStep('Selected free session ID', {
      sessionId: effectiveSessionId,
      attempts: sessionPick.attempts,
    });

    const player1WriteClient = new DeadDropClient({
      contractId,
      rpcUrl,
      networkPassphrase,
      publicKey: player1Signer.publicKey,
      signTransaction: player1Signer.signTransaction,
      signAuthEntry: player1Signer.signAuthEntry,
    });
    const player2WriteClient = new DeadDropClient({
      contractId,
      rpcUrl,
      networkPassphrase,
      publicKey: player2Signer.publicKey,
      signTransaction: player2Signer.signTransaction,
      signAuthEntry: player2Signer.signAuthEntry,
    });

    const bootstrapTimings: Record<string, PhaseTiming> = {};

    {
      const t0 = Date.now();
      const openRes = await signAndSendMutation(player1WriteClient.open_game({
        session_id: effectiveSessionId,
        host: player1Signer.publicKey,
        host_points: hostPoints,
      }, { timeoutInSeconds: 30 }));
      const t1 = Date.now();
      bootstrapTimings.openGame = timingFrom(t0, t1);
      const txResp = (openRes as any)?.getTransactionResponse;
      logStep('Bootstrap open_game result', {
        sessionId: effectiveSessionId,
        txHash: txResp?.hash ?? null,
        txStatus: txResp?.status ?? null,
        ledger: txResp?.ledger ?? null,
      });
      bootstrapSummary = {
        ...(bootstrapSummary ?? {}),
        mode: 'new-session',
        sessionId: effectiveSessionId,
        sessionIdGeneration: sessionPick.attempts,
        openGame: {
          txHash: txResp?.hash ?? null,
          txStatus: txResp?.status ?? null,
          ledger: txResp?.ledger ?? null,
        },
      };
    }

    const randomnessRes = await initSessionRandomness(proverUrl, effectiveSessionId);
    bootstrapTimings.randomnessInit = randomnessRes.timing;
    if (!randomnessRes.response.ok) {
      throw new Error(`Bootstrap randomness init failed (${randomnessRes.response.status}): ${typeof randomnessRes.body === 'string' ? randomnessRes.body : JSON.stringify(randomnessRes.body)}`);
    }
    const randomnessBody = randomnessRes.body as any;
    logStep('Bootstrap randomness/session result', {
      sessionId: effectiveSessionId,
      dropCommitmentHex: randomnessBody?.drop_commitment_hex ?? null,
      randomnessOutputHex: randomnessBody?.randomness_output_hex ? shortHex(String(randomnessBody.randomness_output_hex), 12) : null,
    });

    {
      const t0 = Date.now();
      const joinRes = await signAndSendMutation(player2WriteClient.join_game({
        session_id: effectiveSessionId,
        joiner: player2Signer.publicKey,
        joiner_points: joinerPoints,
        randomness_output: Buffer.from(normalizeHex(String(randomnessBody.randomness_output_hex ?? '')), 'hex'),
        drop_commitment: Buffer.from(normalizeHex(String(randomnessBody.drop_commitment_hex ?? '')), 'hex'),
        randomness_signature: Buffer.from(normalizeHex(String(randomnessBody.randomness_signature_hex ?? '')), 'hex'),
      }, { timeoutInSeconds: 30 }));
      const t1 = Date.now();
      bootstrapTimings.joinGame = timingFrom(t0, t1);
      const txResp = (joinRes as any)?.getTransactionResponse;
      logStep('Bootstrap join_game result', {
        sessionId: effectiveSessionId,
        txHash: txResp?.hash ?? null,
        txStatus: txResp?.status ?? null,
        ledger: txResp?.ledger ?? null,
      });
      bootstrapSummary = {
        ...(bootstrapSummary ?? {}),
        randomnessInit: {
          url: randomnessRes.url,
          status: randomnessRes.response.status,
          dropCommitmentHex: randomnessBody?.drop_commitment_hex ?? null,
          randomnessOutputHex: randomnessBody?.randomness_output_hex ?? null,
          randomnessSignatureHex: randomnessBody?.randomness_signature_hex ?? null,
        },
        joinGame: {
          txHash: txResp?.hash ?? null,
          txStatus: txResp?.status ?? null,
          ledger: txResp?.ledger ?? null,
        },
        bootstrapTimings,
      };
    }

    {
      const { game: summarized, attempts } = await waitForActiveGame(baseReadClient, effectiveSessionId);
      if (!summarized) throw new Error(`Bootstrap failed: game not found after join for session ${effectiveSessionId}`);
      if (summarized.statusName !== 'Active') {
        throw new Error(`Bootstrap failed: expected Active game, got ${summarized.statusName}`);
      }
      logStep('Bootstrap game state confirmed', { ...summarized, readAttempts: attempts });
      bootstrapSummary = {
        ...(bootstrapSummary ?? {}),
        game: { ...summarized, readAttempts: attempts },
      };
    }

    if (cli.bootstrapOnly) {
      logStep('Bootstrap-only completed', {
        sessionId: effectiveSessionId,
        bootstrap: bootstrapSummary,
      });
      if (cli.json) {
        console.log(JSON.stringify({
          ok: true,
          mode: 'bootstrap-only',
          sessionId: effectiveSessionId,
          bootstrap: bootstrapSummary,
        }));
      }
      return;
    }
  }

  const sessionId = assertU32(effectiveSessionId ?? NaN, 'session');
  if (pingX === undefined || pingY === undefined) {
    throw new Error('Missing --ping-x/--ping-y (required unless --bootstrap-only is used)');
  }

  logStep('Dead Drop proof-flow diagnostic starting', {
    sessionId,
    pingX,
    pingY,
    player: cli.player,
    turnOverride: cli.turn ?? null,
    repeat,
    delayBeforeSubmitMs,
    skipSubmit: cli.skipSubmit,
    dumpProofArtifacts: cli.dumpProofArtifacts,
    newSession: cli.newSession,
    bootstrapOnly: cli.bootstrapOnly,
    contractId,
    rpcUrl,
    proverUrl,
    verifierContractId: verifierContractId || null,
    verifierSourceAccount,
    signerPublicKey: signer.publicKey,
  });

  for (let runIndex = 1; runIndex <= repeat; runIndex += 1) {
    const report: RunReport = {
      runIndex,
      config: {
        sessionId,
        pingX,
        pingY,
        player: cli.player,
        turnOverride: cli.turn ?? null,
        delayBeforeSubmitMs,
        skipSubmit: cli.skipSubmit,
        dumpProofArtifacts: cli.dumpProofArtifacts,
        contractId,
        rpcUrl,
        proverUrl,
      },
      signer: { player: cli.player, publicKey: signer.publicKey },
      timings: {},
      preState: null,
      preSubmitState: null,
      postState: null,
      bootstrap: bootstrapSummary,
      prover: null,
      comparison: null,
      flags: {
        turnChangedBeforeSubmit: false,
        preSubmitTurn: null,
        requestedTurn: null,
      },
      submit: null,
      directVerifier: null,
      ok: false,
    };

    logStep(`Run ${runIndex}/${repeat}: initializing clients`);
    const readClient = new DeadDropClient({
      contractId,
      rpcUrl,
      networkPassphrase,
      publicKey: signer.publicKey,
    });
    const writeClient = new DeadDropClient({
      contractId,
      rpcUrl,
      networkPassphrase,
      publicKey: signer.publicKey,
      signTransaction: signer.signTransaction,
      signAuthEntry: signer.signAuthEntry,
    });

    try {
      {
        const t0 = Date.now();
        const bootstrapJoinLedger =
          typeof bootstrapSummary?.joinGame?.ledger === 'number'
            ? bootstrapSummary.joinGame.ledger
            : null;
        const maxPreStateAttempts = bootstrapJoinLedger !== null ? 6 : 1;
        let latestLedger: any = null;
        let game: Game | null = null;
        let lobby: any = null;
        let preStateAttempts = 0;

        for (let attempt = 1; attempt <= maxPreStateAttempts; attempt += 1) {
          preStateAttempts = attempt;
          [latestLedger, game, lobby] = await Promise.all([
            new (await import('@stellar/stellar-sdk')).rpc.Server(rpcUrl).getLatestLedger(),
            simulateRead<Game>(readClient.get_game({ session_id: sessionId })),
            simulateRead<any>(readClient.get_lobby({ session_id: sessionId })),
          ]);

          const isStaleReplica =
            bootstrapJoinLedger !== null
            && typeof latestLedger?.sequence === 'number'
            && latestLedger.sequence < bootstrapJoinLedger;

          // Fresh enough replica, or no bootstrap context to compare against.
          if (!isStaleReplica) {
            break;
          }

          if (attempt < maxPreStateAttempts) {
            logStep('Pre-state stale read detected; retrying', {
              attempt,
              maxAttempts: maxPreStateAttempts,
              latestLedger: latestLedger.sequence,
              bootstrapJoinLedger,
              sessionId,
            });
            await sleep(700);
          }
        }

        const t1 = Date.now();
        report.timings.preState = timingFrom(t0, t1);
        report.preState = {
          latestLedger: latestLedger.sequence,
          bootstrapJoinLedger,
          readAttempts: preStateAttempts,
          game: summarizeGame(game),
          lobby: lobby ? {
            host: lobby.host,
            host_points: String(lobby.host_points),
            created_ledger: lobby.created_ledger,
          } : null,
        };
        logStep('Pre-state snapshot', report.preState);
      }

      const preGame = report.preState?.game as ReturnType<typeof summarizeGame> | null;
      if (!preGame) throw new Error(`Game not found for session ${sessionId}`);

      const requestedTurn = cli.turn !== undefined ? assertU32(cli.turn, 'turn') : preGame.current_turn;
      report.flags.requestedTurn = requestedTurn;
      logStep('Resolved requested turn', { requestedTurn, onChainCurrentTurn: preGame.current_turn, turnOverride: cli.turn ?? null });

      const randomnessRes = await initSessionRandomness(proverUrl, sessionId);
      report.timings.randomnessInit = randomnessRes.timing;
      if (!randomnessRes.response.ok) {
        throw new Error(`Randomness init failed (${randomnessRes.response.status}): ${typeof randomnessRes.body === 'string' ? randomnessRes.body : JSON.stringify(randomnessRes.body)}`);
      }
      logStep('Session randomness initialized', {
        url: randomnessRes.url,
        status: randomnessRes.response.status,
        dropCommitmentHex: (randomnessRes.body as any)?.drop_commitment_hex ?? null,
        randomnessOutputHex: (randomnessRes.body as any)?.randomness_output_hex ? shortHex(String((randomnessRes.body as any).randomness_output_hex), 12) : null,
      });
      const backendDropCommitmentHex = normalizeHex(String((randomnessRes.body as any)?.drop_commitment_hex ?? ''));
      const onChainDropCommitmentHex = preGame.drop_commitment_hex ? normalizeHex(String(preGame.drop_commitment_hex)) : null;
      if (onChainDropCommitmentHex && backendDropCommitmentHex && onChainDropCommitmentHex !== backendDropCommitmentHex) {
        logStep('WARNING: Backend randomness does not match on-chain commitment for this session', {
          sessionId,
          onChainDropCommitmentHex,
          backendDropCommitmentHex,
          likelyCause: 'prover backend restart (in-memory hidden drop cache reset)',
          recommendation: 'Use --new-session or persist hiddenDropBySession in backend',
        });
      }

      const proverRes = await callProver(proverUrl, { sessionId, turn: requestedTurn, pingX, pingY });
      report.timings.prover = proverRes.timing;
      if (!proverRes.response.ok) {
        report.prover = {
          ok: false,
          status: proverRes.response.status,
          body: proverRes.body,
          url: proverRes.url,
        };
        throw new Error(`Prover request failed (${proverRes.response.status}): ${typeof proverRes.body === 'string' ? proverRes.body : JSON.stringify(proverRes.body)}`);
      }

      const body = proverRes.body as any;
      const proofHex = normalizeHex(String(body.proof_hex ?? ''));
      const publicInputsHex = Array.isArray(body.public_inputs_hex) ? body.public_inputs_hex.map((v: unknown) => normalizeHex(String(v))) : [];
      const distance = Number(body.distance);

      report.prover = {
        ok: true,
        url: proverRes.url,
        status: proverRes.response.status,
        distance,
        proofHexLength: proofHex.length,
        proofFingerprint: proofHex ? proofFingerprintHex(proofHex) : null,
        proofPreview: proofHex ? shortHex(proofHex, 12) : null,
        publicInputsCount: publicInputsHex.length,
        publicInputsHex,
      };
      logStep('Prover response summary', {
        distance,
        proofHexLength: proofHex.length,
        proofFingerprint: report.prover.proofFingerprint,
        publicInputsCount: publicInputsHex.length,
        publicInputs: publicInputsHex.map((h: string, idx: number) => ({ idx, value: h })),
      });

      if (verifierContractId) {
        report.directVerifier = await runDirectVerifierCheck({
          verifierContractId,
          verifierSourceAccount,
          proofHex,
          publicInputsHex,
        });
        logStep('Direct verifier check result', report.directVerifier);
      }

      report.comparison = decodePublicInputComparison({
        publicInputsHex,
        requestedSessionId: sessionId,
        requestedTurn,
        pingX,
        pingY,
        proverDistance: distance,
        onChainDropCommitmentHex: preGame.drop_commitment_hex,
      });
      logStep('Public-input comparison', report.comparison);

      const artifactDump = await maybeDumpProofArtifacts({
        enabled: cli.dumpProofArtifacts,
        runIndex,
        sessionId,
        requestedTurn,
        pingX,
        pingY,
        proofHex,
        publicInputsHex,
        report,
      });
      if (artifactDump) {
        report.prover = { ...(report.prover ?? {}), artifactDump };
        logStep('Proof artifacts dumped', artifactDump);
      }

      {
        const t0 = Date.now();
        const latestLedger = await new (await import('@stellar/stellar-sdk')).rpc.Server(rpcUrl).getLatestLedger();
        const game = await simulateRead<Game>(readClient.get_game({ session_id: sessionId }));
        const t1 = Date.now();
        report.timings.preSubmitState = timingFrom(t0, t1);
        report.preSubmitState = {
          latestLedger: latestLedger.sequence,
          game: summarizeGame(game),
        };
        report.flags.preSubmitTurn = report.preSubmitState?.game?.current_turn ?? null;
        report.flags.turnChangedBeforeSubmit = report.flags.preSubmitTurn !== requestedTurn;
        logStep('Pre-submit state snapshot', {
          ...report.preSubmitState,
          turnChangedBeforeSubmit: report.flags.turnChangedBeforeSubmit,
          requestedTurn,
        });
      }

      if (delayBeforeSubmitMs > 0) {
        logStep('Delaying before submit', { delayBeforeSubmitMs });
        await sleep(delayBeforeSubmitMs);
      }

      if (cli.skipSubmit) {
        report.submit = { ok: true, skipped: true, reason: '--skip-submit' };
        report.ok = Boolean(report.comparison?.pass) && (report.directVerifier?.ok ?? true);
        logStep(`Run ${runIndex} ${report.ok ? 'PASS' : 'FAIL'} (submit skipped)`, {
          comparisonPass: report.comparison?.pass ?? false,
          directVerifierOk: report.directVerifier?.ok ?? null,
        });
        if (cli.json) {
          console.log(JSON.stringify(report));
        }
        continue;
      }

      const proofBuffer = Buffer.from(proofHex, 'hex');
      const publicInputBuffers = publicInputsHex.map((h) => Buffer.from(h, 'hex'));

      const tSubmit0 = Date.now();
      const tx = await writeClient.submit_ping({
        session_id: sessionId,
        player: signer.publicKey,
        turn: requestedTurn,
        distance,
        ping_x: pingX,
        ping_y: pingY,
        proof: proofBuffer,
        public_inputs: publicInputBuffers,
      }, { timeoutInSeconds: 30 });
      const simulated = await tx.simulate();
      const submitRes = await simulated.signAndSend();
      const tSubmit1 = Date.now();
      report.timings.submit = timingFrom(tSubmit0, tSubmit1);

      const txResp = (submitRes as any)?.getTransactionResponse;
      report.submit = {
        ok: true,
        txStatus: txResp?.status ?? null,
        txHash: txResp?.hash ?? null,
        ledger: txResp?.ledger ?? null,
        simulatedResultType: typeof simulated?.result,
      };
      logStep('Submit result', report.submit);

      {
        const t0 = Date.now();
        const latestLedger = await new (await import('@stellar/stellar-sdk')).rpc.Server(rpcUrl).getLatestLedger();
        const game = await simulateRead<Game>(readClient.get_game({ session_id: sessionId }));
        const t1 = Date.now();
        report.timings.postState = timingFrom(t0, t1);
        report.postState = {
          latestLedger: latestLedger.sequence,
          game: summarizeGame(game),
        };
        logStep('Post-submit state snapshot', report.postState);
      }

      report.ok = true;
      logStep(`Run ${runIndex} PASS`, {
        turnChangedBeforeSubmit: report.flags.turnChangedBeforeSubmit,
        txHash: report.submit?.txHash ?? null,
      });
    } catch (err) {
      const parsed = parseContractError(err);
      report.submit = {
        ok: false,
        error: parsed,
      };
      report.ok = false;
      logStep(`Run ${runIndex} FAIL`, parsed);
    }

    if (cli.json) {
      console.log(JSON.stringify(report));
    }
  }
}

main().catch((err) => {
  console.error('Fatal error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
