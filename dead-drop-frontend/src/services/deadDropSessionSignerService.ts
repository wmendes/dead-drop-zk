import { Keypair } from '@stellar/stellar-sdk';
import type { AssembledTransaction } from '@stellar/stellar-sdk/contract';
import {
  createCallContractContext,
  createDelegatedSigner,
  LEDGERS_PER_HOUR,
  type SmartAccountKit,
  type TransactionResult,
} from 'smart-account-kit';
import type { ContextRule, Signer as ContextSigner } from 'smart-account-kit-bindings';
import { NETWORK } from '../utils/constants';

const SESSION_RULE_PREFIX = 'Dead Drop Session Signer';
const SESSION_REFRESH_LEDGER_BUFFER = 120;
const SESSION_SIGNER_UNAVAILABLE_ERROR =
  'Dead Drop session signer is unavailable for gameplay. Re-open or re-join the lobby to refresh the session signer.';
const SESSION_SIGNER_UNSUPPORTED_NETWORK_ERROR =
  'Dead Drop session signer is supported on testnet only in this build.';

interface SessionSignerState {
  walletContractId: string;
  gameContractId: string;
  sessionId: number;
  delegatedPublicKey: string;
  delegatedSecret: string;
  contextRuleId: number;
  validUntilLedger: number;
  expiresAtMs: number;
}

interface ExecuteSessionSignerParams<T = unknown> {
  kit: SmartAccountKit;
  credentialId?: string | null;
  walletContractId: string;
  gameContractId: string;
  sessionId?: number;
  ttlMinutes: number;
  allowProvisioning?: boolean;
  tx: AssembledTransaction<T>;
}

let sessionState: SessionSignerState | null = null;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isDelegatedSignerForAddress(signer: unknown, address: string): boolean {
  if (!signer || typeof signer !== 'object') return false;
  const parsed = signer as { tag?: string; values?: unknown[] };
  return parsed.tag === 'Delegated' && Array.isArray(parsed.values) && parsed.values[0] === address;
}

function delegatedAddressFromSigner(signer: unknown): string | null {
  if (!signer || typeof signer !== 'object') return null;
  const parsed = signer as { tag?: string; values?: unknown[] };
  if (parsed.tag !== 'Delegated' || !Array.isArray(parsed.values) || typeof parsed.values[0] !== 'string') {
    return null;
  }
  return parsed.values[0];
}

function parseRuleId(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  throw new Error('Failed to parse context rule id.');
}

function parseValidUntilLedger(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  if (!value || typeof value !== 'object') return null;

  const option = value as { tag?: string; values?: unknown[] };
  if (option.tag === 'Some' && Array.isArray(option.values) && option.values.length > 0) {
    return parseValidUntilLedger(option.values[0]);
  }
  if (option.tag === 'None') return null;

  return null;
}

function parseSessionId(value: number | undefined): number {
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new Error('Dead Drop session signer requires a valid session id.');
  }
  return value as number;
}

function isManagedSessionRule(rule: ContextRule): boolean {
  return typeof rule.name === 'string' && rule.name.startsWith(SESSION_RULE_PREFIX);
}

function isCleanSessionRule(rule: ContextRule): boolean {
  if (!isManagedSessionRule(rule)) return false;
  if (rule.policies.length !== 0) return false;
  if (rule.signers.length !== 1) return false;
  return delegatedAddressFromSigner(rule.signers[0]) !== null;
}

function isMatchingSessionState(
  state: SessionSignerState | null,
  walletContractId: string,
  gameContractId: string,
  sessionId: number,
): state is SessionSignerState {
  if (!state) return false;
  return (
    state.walletContractId === walletContractId
    && state.gameContractId === gameContractId
    && state.sessionId === sessionId
  );
}

function isAccountMissingError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  return (
    normalized.includes('not found')
    || normalized.includes('resource missing')
    || normalized.includes('account not found')
    || normalized.includes('404')
  );
}

async function accountExistsOnRpc(kit: SmartAccountKit, address: string): Promise<boolean> {
  try {
    await kit.rpc.getAccount(address);
    return true;
  } catch (error) {
    if (isAccountMissingError(error)) return false;
    throw new Error(`Failed to check delegated signer account: ${String(error)}`);
  }
}

async function ensureDelegatedAccountReady(kit: SmartAccountKit, address: string): Promise<void> {
  if (await accountExistsOnRpc(kit, address)) return;

  if (NETWORK !== 'testnet') {
    throw new Error(SESSION_SIGNER_UNSUPPORTED_NETWORK_ERROR);
  }

  const fundRes = await fetch(`https://friendbot.stellar.org?addr=${address}`, {
    method: 'GET',
  });
  if (!fundRes.ok) {
    throw new Error(`Friendbot funding failed (${fundRes.status}) for delegated signer.`);
  }

  for (let attempt = 0; attempt < 5; attempt += 1) {
    await sleep(700);
    if (await accountExistsOnRpc(kit, address)) return;
  }

  throw new Error('Delegated signer account funding was submitted but account is not visible on RPC yet.');
}

function readSimulationResultRaw(simulation: unknown): unknown {
  return (simulation as { result?: unknown })?.result;
}

async function readRulesForContract(kit: SmartAccountKit, gameContractId: string): Promise<ContextRule[]> {
  const contextType = createCallContractContext(gameContractId);
  const tx = await kit.rules.getAll(contextType);
  const simulation = await tx.simulate();
  const directResult = readSimulationResultRaw(simulation);

  if (Array.isArray(directResult)) {
    return directResult as ContextRule[];
  }

  if (
    directResult
    && typeof directResult === 'object'
    && 'isOk' in directResult
    && typeof (directResult as { isOk: () => boolean }).isOk === 'function'
  ) {
    const resultWrapper = directResult as { isOk: () => boolean; unwrap: () => unknown };
    if (resultWrapper.isOk()) {
      const unwrapped = resultWrapper.unwrap();
      if (Array.isArray(unwrapped)) return unwrapped as ContextRule[];
    }
  }

  return [];
}

async function signAndSubmitWithPasskey(
  kit: SmartAccountKit,
  tx: AssembledTransaction<unknown>,
  credentialId: string | null | undefined,
  action: string,
): Promise<void> {
  const result = await kit.signAndSubmit(tx, {
    credentialId: credentialId || undefined,
  });
  if (!result.success) {
    throw new Error(`${action} failed: ${result.error || 'unknown error'}`);
  }
}

function clearExternalSignerFromState(kit: SmartAccountKit, state: SessionSignerState | null): void {
  if (!state) return;
  if (kit.externalSigners.canSignFor(state.delegatedPublicKey)) {
    kit.externalSigners.remove(state.delegatedPublicKey);
  }
}

function ensureExternalSignerFromState(kit: SmartAccountKit, state: SessionSignerState): void {
  if (kit.externalSigners.canSignFor(state.delegatedPublicKey)) return;
  if (!state.delegatedSecret) return;
  kit.externalSigners.addFromSecret(state.delegatedSecret);
}

function isSessionUsable(
  state: SessionSignerState,
  kit: SmartAccountKit,
  walletContractId: string,
  gameContractId: string,
  sessionId: number,
): boolean {
  if (state.walletContractId !== walletContractId) return false;
  if (state.gameContractId !== gameContractId) return false;
  if (state.sessionId !== sessionId) return false;
  if (state.expiresAtMs <= Date.now()) return false;
  return kit.externalSigners.canSignFor(state.delegatedPublicKey);
}

function pickManagedRule(rules: ContextRule[]): ContextRule | null {
  const managed = rules.filter(isCleanSessionRule);
  if (managed.length === 0) return null;

  managed.sort((a, b) => parseRuleId(b.id) - parseRuleId(a.id));
  return managed[0] || null;
}

function shouldRefreshExpiration(validUntil: number | null, latestLedger: number): boolean {
  if (validUntil === null) return false;
  return validUntil <= latestLedger + SESSION_REFRESH_LEDGER_BUFFER;
}

async function provisionSessionSigner<T>(
  params: ExecuteSessionSignerParams<T>,
  sessionId: number,
): Promise<SessionSignerState> {
  const { kit, credentialId, walletContractId, gameContractId, ttlMinutes } = params;
  const safeTtlMinutes = Math.max(1, Math.floor(ttlMinutes));
  const ledgersPerMinute = LEDGERS_PER_HOUR / 60;

  const latestLedger = await kit.rpc.getLatestLedger();
  const ledgersToAdd = Math.max(1, Math.ceil(safeTtlMinutes * ledgersPerMinute));
  const desiredValidUntilLedger = latestLedger.sequence + ledgersToAdd;

  const matchingState = isMatchingSessionState(sessionState, walletContractId, gameContractId, sessionId)
    ? sessionState
    : null;
  if (matchingState) {
    ensureExternalSignerFromState(kit, matchingState);
  }

  const rules = await readRulesForContract(kit, gameContractId);
  const managedRule = pickManagedRule(rules);

  let contextRuleId = 0;
  let delegatedPublicKey = '';
  let delegatedSecret = '';
  let currentValidUntil: number | null = null;

  const createCleanRule = async (): Promise<void> => {
    if (matchingState && kit.externalSigners.canSignFor(matchingState.delegatedPublicKey)) {
      delegatedPublicKey = matchingState.delegatedPublicKey;
      delegatedSecret = matchingState.delegatedSecret;
    } else {
      const keypair = Keypair.random();
      delegatedPublicKey = keypair.publicKey();
      delegatedSecret = keypair.secret();
    }

    await ensureDelegatedAccountReady(kit, delegatedPublicKey);

    const createRuleTx = await kit.rules.add(
      createCallContractContext(gameContractId),
      SESSION_RULE_PREFIX,
      [createDelegatedSigner(delegatedPublicKey)],
      new Map(),
      desiredValidUntilLedger,
    );
    await signAndSubmitWithPasskey(
      kit,
      createRuleTx as AssembledTransaction<unknown>,
      credentialId,
      'Creating clean session signer rule'
    );

    const refreshedRules = await readRulesForContract(kit, gameContractId);
    const createdRule = refreshedRules.find((rule) =>
      isCleanSessionRule(rule)
      && rule.signers.some((signer) => isDelegatedSignerForAddress(signer, delegatedPublicKey))
    );
    if (!createdRule) {
      throw new Error('Session signer rule was created but could not be reloaded from chain.');
    }

    contextRuleId = parseRuleId(createdRule.id);
    currentValidUntil = parseValidUntilLedger(createdRule.valid_until) ?? desiredValidUntilLedger;
  };

  if (managedRule) {
    contextRuleId = parseRuleId(managedRule.id);
    currentValidUntil = parseValidUntilLedger(managedRule.valid_until);

    const managedDelegatedAddress = delegatedAddressFromSigner(managedRule.signers[0]);
    if (!managedDelegatedAddress) {
      await createCleanRule();
    } else {
      if (
        matchingState
        && matchingState.delegatedPublicKey === managedDelegatedAddress
        && kit.externalSigners.canSignFor(matchingState.delegatedPublicKey)
      ) {
        delegatedPublicKey = matchingState.delegatedPublicKey;
        delegatedSecret = matchingState.delegatedSecret;
      } else if (kit.externalSigners.canSignFor(managedDelegatedAddress)) {
        delegatedPublicKey = managedDelegatedAddress;
        if (matchingState?.delegatedPublicKey === managedDelegatedAddress) {
          delegatedSecret = matchingState.delegatedSecret;
        }
      }

      if (!delegatedPublicKey) {
        await createCleanRule();
      } else if (shouldRefreshExpiration(currentValidUntil, latestLedger.sequence)) {
        const refreshRuleTx = await kit.rules.updateExpiration(contextRuleId, desiredValidUntilLedger);
        await signAndSubmitWithPasskey(
          kit,
          refreshRuleTx as AssembledTransaction<unknown>,
          credentialId,
          'Refreshing session signer expiration'
        );
        currentValidUntil = desiredValidUntilLedger;
      }
    }
  } else {
    await createCleanRule();
  }

  if (delegatedSecret && !kit.externalSigners.canSignFor(delegatedPublicKey)) {
    kit.externalSigners.addFromSecret(delegatedSecret);
  }
  if (!kit.externalSigners.canSignFor(delegatedPublicKey)) {
    throw new Error('Delegated session signer is not available in memory for transaction signing.');
  }

  const effectiveValidUntil = currentValidUntil ?? desiredValidUntilLedger;
  const ledgersRemaining = Math.max(1, effectiveValidUntil - latestLedger.sequence);
  const minutesRemaining = ledgersRemaining / ledgersPerMinute;
  const expiresAtMs = Date.now() + Math.max(1, minutesRemaining) * 60_000;

  sessionState = {
    walletContractId,
    gameContractId,
    sessionId,
    delegatedPublicKey,
    delegatedSecret,
    contextRuleId,
    validUntilLedger: effectiveValidUntil,
    expiresAtMs,
  };

  return sessionState;
}

async function ensureSessionSigner<T>(
  params: ExecuteSessionSignerParams<T>
): Promise<SessionSignerState> {
  const { kit, walletContractId, gameContractId } = params;
  const allowProvisioning = params.allowProvisioning ?? true;
  const sessionId = parseSessionId(params.sessionId);

  if (sessionState) {
    ensureExternalSignerFromState(kit, sessionState);
  }

  if (
    sessionState
    && isSessionUsable(sessionState, kit, walletContractId, gameContractId, sessionId)
  ) {
    return sessionState;
  }

  if (sessionState) {
    clearExternalSignerFromState(kit, sessionState);
    sessionState = null;
  }

  if (!allowProvisioning) {
    throw new Error(SESSION_SIGNER_UNAVAILABLE_ERROR);
  }

  if (NETWORK !== 'testnet') {
    throw new Error(SESSION_SIGNER_UNSUPPORTED_NETWORK_ERROR);
  }

  return provisionSessionSigner(params, sessionId);
}

export function clearDeadDropSessionSignerState(kit?: SmartAccountKit): void {
  if (kit) {
    clearExternalSignerFromState(kit, sessionState);
  }
  sessionState = null;
}

export function scheduleDeadDropSessionSignerCleanup(kit?: SmartAccountKit): void {
  if (kit) {
    clearExternalSignerFromState(kit, sessionState);
  }
  sessionState = null;
}

export function isDeadDropSessionSignerUnavailableError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.message.includes(SESSION_SIGNER_UNAVAILABLE_ERROR)
    || error.message.includes(SESSION_SIGNER_UNSUPPORTED_NETWORK_ERROR)
  );
}

export async function executeDeadDropWithSessionSigner<T>(
  params: ExecuteSessionSignerParams<T>
): Promise<TransactionResult> {
  const { kit, tx } = params;
  const readySession = await ensureSessionSigner(params);

  const selectedSigners = [
    {
      type: 'wallet' as const,
      walletAddress: readySession.delegatedPublicKey,
      label: 'Dead Drop Session Signer',
      signer: createDelegatedSigner(readySession.delegatedPublicKey) as ContextSigner,
    },
  ];

  const result = await kit.multiSigners.operation(tx, selectedSigners);
  if (!result.success) {
    throw new Error(result.error || 'Session signer transaction failed');
  }
  return result;
}
