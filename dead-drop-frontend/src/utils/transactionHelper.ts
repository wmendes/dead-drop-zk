/**
 * Transaction helper utilities
 */

import { Address, authorizeEntry, contract, rpc, xdr } from '@stellar/stellar-sdk';
import { Buffer } from 'buffer';
import { DEAD_DROP_RELAYER_URL, RPC_URL } from './constants';
const DEAD_DROP_DEBUG = import.meta.env.DEV || import.meta.env.VITE_DEAD_DROP_DEBUG === 'true';

interface RelayerSubmitResponse {
  hash: string;
  status: string;
  ledger?: number | null;
  return_value_xdr?: string | null;
  errorResultXdr?: string | null;
  latestLedger?: number | null;
}

type WalletSignResult = {
  signedAuthEntry: string;
  signerAddress?: string;
  error?: { message?: string };
};

type SignAuthEntryCallback = (
  xdr: string,
  opts?: { networkPassphrase?: string; address?: string }
) => Promise<WalletSignResult>;

type RelayerSignerOptions = {
  signAuthEntry?: SignAuthEntryCallback;
  signAssembledTransaction?: (tx: contract.AssembledTransaction<unknown>) => Promise<void>;
};

const TX_BAD_SEQ_RESULT_CODE = -5;

function decodeTxResultCodeFromXdr(errorResultXdr?: string | null): number | null {
  if (!errorResultXdr) return null;
  try {
    const raw = Buffer.from(errorResultXdr, 'base64');
    // TransactionResult XDR starts with:
    // feeCharged: i64 (8 bytes), result discriminant: i32 (4 bytes)
    if (raw.length < 12) return null;
    return raw.readInt32BE(8);
  } catch {
    return null;
  }
}

function isTxBadSeqFromRelayerPayload(payload: RelayerSubmitResponse): boolean {
  return decodeTxResultCodeFromXdr(payload.errorResultXdr) === TX_BAD_SEQ_RESULT_CODE;
}

function isTxBadSeqError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('txBAD_SEQ') || message.includes('bad sequence');
}

function parseSignedEntryXdr(
  signedAuthEntry: string,
  expectedAddress: string
): xdr.SorobanAuthorizationEntry | null {
  try {
    const parsed = xdr.SorobanAuthorizationEntry.fromXDR(signedAuthEntry, 'base64');
    if (parsed.credentials().switch().name !== 'sorobanCredentialsAddress') {
      return null;
    }

    const creds = parsed.credentials().address();
    const parsedAddress = Address.fromScAddress(creds.address()).toString();
    if (parsedAddress !== expectedAddress) return null;
    if (creds.signature().switch().name === 'scvVoid') return null;
    return parsed;
  } catch {
    return null;
  }
}

async function resolveAuthExpiration(validUntilLedgerSeq?: number): Promise<number> {
  if (validUntilLedgerSeq) return validUntilLedgerSeq;
  const server = new rpc.Server(RPC_URL);
  const latest = await server.getLatestLedger();
  return latest.sequence + 100;
}

async function signInvokeAuthEntries(
  tx: contract.AssembledTransaction<any>,
  signer?: RelayerSignerOptions,
  validUntilLedgerSeq?: number
): Promise<void> {
  const signAuthEntry =
    ((tx as any)?.options?.signAuthEntry as SignAuthEntryCallback | undefined) ??
    signer?.signAuthEntry;

  const built = (tx as any).built;
  if (!built || !Array.isArray(built.operations) || built.operations.length !== 1) {
    throw new Error('Relayer submission expects exactly one invokeHostFunction operation');
  }

  const op = built.operations[0];
  if (!op || op.type !== 'invokeHostFunction') {
    throw new Error('Relayer submission requires invokeHostFunction operation');
  }

  // Some SDK/binding flows keep auth entries in simulationData only.
  // Prefer operation auth, but fall back to simulation auth when empty.
  const opAuth = Array.isArray(op.auth) ? op.auth : [];
  const simAuth = Array.isArray((tx as any)?.simulationData?.result?.auth)
    ? ((tx as any).simulationData.result.auth as any[])
    : [];
  const authEntries = opAuth.length > 0 ? opAuth : simAuth.slice();
  if (authEntries.length === 0) return;

  const hasUnsignedAddressAuth = authEntries.some(
    (entry: any) =>
      !!entry &&
      entry.credentials().switch().name === 'sorobanCredentialsAddress' &&
      entry.credentials().address().signature().switch().name === 'scvVoid'
  );
  if (hasUnsignedAddressAuth && typeof signAuthEntry !== 'function') {
    throw new Error('Missing signAuthEntry callback for unsigned auth entries. Wallet signer is not wired to this transaction.');
  }
  const walletSignAuthEntry = signAuthEntry as
    | SignAuthEntryCallback
    | undefined;

  const expiration = await resolveAuthExpiration(validUntilLedgerSeq);
  const networkPassphrase = (tx as any)?.options?.networkPassphrase as string | undefined;

  for (let i = 0; i < authEntries.length; i++) {
    const entry = authEntries[i];
    if (!entry || entry.credentials().switch().name !== 'sorobanCredentialsAddress') {
      continue;
    }

    const creds = entry.credentials().address();
    if (creds.signature().switch().name !== 'scvVoid') {
      continue;
    }

    const authAddress = Address.fromScAddress(creds.address()).toString();
    // Smart-account contract addresses (C...) should return a full signed auth entry.
    if (authAddress.startsWith('C')) {
      const signResult = await walletSignAuthEntry!(entry.toXDR('base64'), {
        networkPassphrase,
        address: authAddress,
      });

      if (signResult?.error?.message) {
        throw new Error(`Failed to sign auth entry for ${authAddress}: ${signResult.error.message}`);
      }

      const signedAuth = signResult?.signedAuthEntry;
      if (typeof signedAuth !== 'string' || !signedAuth) {
        throw new Error(`Signer returned empty auth entry payload for ${authAddress}`);
      }

      const parsedSignedEntry = parseSignedEntryXdr(signedAuth, authAddress);
      if (!parsedSignedEntry) {
        throw new Error(`Smart-account signer did not return a valid signed auth entry for ${authAddress}`);
      }

      authEntries[i] = parsedSignedEntry;
      continue;
    }

    // External wallets/dev keypairs (G...) return raw signature bytes over the preimage.
    authEntries[i] = await authorizeEntry(
      entry,
      async (preimage) => {
        const signResult = await walletSignAuthEntry!(preimage.toXDR('base64'), {
          networkPassphrase,
          address: authAddress,
        });

        if (signResult?.error?.message) {
          throw new Error(`Failed to sign preimage for ${authAddress}: ${signResult.error.message}`);
        }

        const signature = signResult?.signedAuthEntry;
        if (typeof signature !== 'string' || !signature) {
          throw new Error(`Signer returned empty signature payload for ${authAddress}`);
        }

        return Buffer.from(signature, 'base64');
      },
      expiration,
      networkPassphrase
    );
  }

  op.auth = authEntries;
}

function normalizeRelayerBaseUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

function resolveRelayerFuncPayload(op: any): string {
  const candidates: string[] = [];

  try {
    if (op?.func && typeof op.func.toXDR === 'function') {
      candidates.push(op.func.toXDR('base64'));
    }
  } catch {
    // ignore
  }

  try {
    if (op && typeof op.toXDR === 'function') {
      candidates.push(op.toXDR('base64'));
    }
  } catch {
    // ignore
  }

  for (const candidate of candidates) {
    try {
      xdr.HostFunction.fromXDR(candidate, 'base64');
      return candidate;
    } catch {
      // keep trying
    }
  }

  for (const candidate of candidates) {
    try {
      const parsedOp = xdr.Operation.fromXDR(candidate, 'base64');
      if (parsedOp.body().switch().name === 'invokeHostFunction') {
        return candidate;
      }
    } catch {
      // keep trying
    }
  }

  throw new Error('Could not encode invokeHostFunction payload for relayer submission.');
}

function tryExtractInvokeFunctionName(op: any): string | null {
  try {
    if (op?.func && typeof op.func.switch === 'function') {
      const hostFnType = op.func.switch().name;
      if (hostFnType === 'hostFunctionTypeInvokeContract') {
        const invokeContract = op.func.invokeContract();
        const rawName = invokeContract.functionName();
        return typeof rawName === 'string' ? rawName : Buffer.from(rawName).toString('utf-8');
      }
    }
  } catch {
    // best effort only
  }
  return null;
}

function summarizeAuthCredentialTypes(entries: any[]): {
  sourceAccount: number;
  address: number;
  other: number;
} {
  let sourceAccount = 0;
  let address = 0;
  let other = 0;

  for (const entry of entries) {
    try {
      const credSwitch = entry?.credentials?.().switch().name;
      if (credSwitch === 'sorobanCredentialsSourceAccount') {
        sourceAccount += 1;
      } else if (credSwitch === 'sorobanCredentialsAddress') {
        address += 1;
      } else {
        other += 1;
      }
    } catch {
      other += 1;
    }
  }

  return { sourceAccount, address, other };
}

async function submitViaRelayer(
  tx: contract.AssembledTransaction<any>,
  signer?: RelayerSignerOptions,
  validUntilLedgerSeq?: number,
  options?: { direct?: boolean }
): Promise<contract.SentTransaction<any>> {
  const hasBuiltTx = !!(tx as any)?.built;
  const hasSimulationAuth = Array.isArray((tx as any)?.simulationData?.result?.auth);
  // Avoid re-simulating already-simulated invoke transactions with unsigned
  // contract auth entries (C-address), which can trap on __check_auth before
  // we get a chance to inject passkey signatures.
  const prepared =
    hasBuiltTx && hasSimulationAuth
      ? tx
      : await tx.simulate();
  if (DEAD_DROP_DEBUG) {
    console.info('[TxHelper][relayer] Prepared tx', {
      reusedPreparedTx: hasBuiltTx && hasSimulationAuth,
      hasBuiltAfterPrepare: Boolean((prepared as any)?.built),
      hasSimulationAuth: Boolean((prepared as any)?.simulationData?.result?.auth?.length),
    });
  }

  if (typeof signer?.signAssembledTransaction === 'function') {
    if (DEAD_DROP_DEBUG) {
      console.info('[TxHelper][relayer] Running signAssembledTransaction hook');
    }
    await signer.signAssembledTransaction(prepared as contract.AssembledTransaction<unknown>);
  }

  // Sign address-based auth entries in a wallet-agnostic way:
  // - external wallets/dev keypairs return raw signature bytes
  // - passkey smart accounts return a full signed auth entry
  await signInvokeAuthEntries(prepared, signer, validUntilLedgerSeq);

  const built = (prepared as any).built;
  if (!built || !Array.isArray(built.operations) || built.operations.length !== 1) {
    throw new Error('Relayer submission expects exactly one invokeHostFunction operation');
  }

  const op = built.operations[0];
  if (!op || op.type !== 'invokeHostFunction' || !op.func) {
    throw new Error('Relayer submission requires invokeHostFunction operation');
  }

  // Filter auth entries for relayer submission:
  // 1. Remove source account credentials (relayer manages source account)
  // 2. Validate no unsigned smart-account entries
  const originalAuthEntries = Array.isArray(op.auth) ? op.auth : [];
  const authSummaryBefore = summarizeAuthCredentialTypes(originalAuthEntries);
  if (DEAD_DROP_DEBUG) {
    console.info('[TxHelper][relayer] Auth credential breakdown before filtering', authSummaryBefore);
  }
  let filteredAuthEntries: any[] = [];
  if (Array.isArray(op.auth)) {
    for (const entry of op.auth) {
      try {
        const credSwitch = entry.credentials().switch().name;

        // Skip source account credentials - relayer will add its own
        if (credSwitch === 'sorobanCredentialsSourceAccount') {
          if (DEAD_DROP_DEBUG) {
            console.info('[TxHelper][relayer] Filtering out source account credential (relayer will provide)');
          }
          continue;
        }

        // Only address credentials are allowed
        if (credSwitch !== 'sorobanCredentialsAddress') {
          if (DEAD_DROP_DEBUG) {
            console.warn('[TxHelper][relayer] Unknown credential type:', credSwitch);
          }
          continue;
        }

        const creds = entry.credentials().address();
        const authAddress = Address.fromScAddress(creds.address()).toString();

        // Validate smart accounts are signed
        if (authAddress.startsWith('C') && creds.signature().switch().name === 'scvVoid') {
          throw new Error(`Unsigned smart-account auth entry detected for ${authAddress}. Passkey signing did not run.`);
        }

        filteredAuthEntries.push(entry);
      } catch (err) {
        if (err instanceof Error) throw err;
        throw new Error('Failed to validate auth entries before relayer submission.');
      }
    }
  }
  if (
    filteredAuthEntries.length === 0 &&
    authSummaryBefore.sourceAccount > 0 &&
    authSummaryBefore.address === 0
  ) {
    throw new Error(
      'Relayer submission is incompatible with source-account-only Soroban auth for this transaction. Build/simulate the transaction with a neutral simulation source so the user authorization appears as an address auth entry.'
    );
  }
  if (DEAD_DROP_DEBUG) {
    console.info('[TxHelper][relayer] Auth credential breakdown after filtering', {
      ...summarizeAuthCredentialTypes(filteredAuthEntries),
      kept: filteredAuthEntries.length,
    });
  }

  const endpoint = options?.direct ? '/tx/submit-direct' : '/tx/submit';
  if (DEAD_DROP_DEBUG) {
    console.info('[TxHelper][relayer] Submitting', {
      endpoint,
      functionName: tryExtractInvokeFunctionName(op),
      totalAuthEntries: Array.isArray(op.auth) ? op.auth.length : 0,
      filteredAuthEntries: filteredAuthEntries.length,
      rpcUrl: RPC_URL,
    });
  }
  const response = await fetch(`${normalizeRelayerBaseUrl(DEAD_DROP_RELAYER_URL)}${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      func_xdr: resolveRelayerFuncPayload(op),
      auth_entries_xdr: filteredAuthEntries.map((entry: any) => entry.toXDR('base64')),
      rpc_url: RPC_URL,
    }),
  });

  if (!response.ok) {
    const errBody = await response.json().catch(() => null);
    const message =
      (errBody && typeof errBody.error === 'string' && errBody.error) ||
      `Relayer submission failed (${response.status})`;
    throw new Error(message);
  }

  const payload = (await response.json()) as RelayerSubmitResponse;
  if (DEAD_DROP_DEBUG) {
    console.info('[TxHelper][relayer] Response payload', {
      status: payload?.status,
      hash: payload?.hash,
      ledger: payload?.ledger,
      latestLedger: payload?.latestLedger,
      hasErrorResultXdr: Boolean(payload?.errorResultXdr),
    });
  }
  if (!payload || typeof payload.hash !== 'string' || !payload.hash) {
    throw new Error('Relayer response missing transaction hash');
  }

  if (payload.status !== 'SUCCESS') {
    if (isTxBadSeqFromRelayerPayload(payload)) {
      throw new Error(
        `txBAD_SEQ: stale transaction sequence during relayer submission` +
        (typeof payload.latestLedger === 'number' ? ` (latestLedger=${payload.latestLedger})` : '')
      );
    }
    throw new Error(`Transaction failed via relayer (status: ${payload.status || 'UNKNOWN'})`);
  }

  let result: unknown = undefined;
  if (typeof payload.return_value_xdr === 'string' && payload.return_value_xdr) {
    try {
      result = xdr.ScVal.fromXDR(payload.return_value_xdr, 'base64');
    } catch {
      result = undefined;
    }
  }

  return {
    result: result as any,
    getTransactionResponse: {
      status: payload.status,
      hash: payload.hash,
      ledger: payload.ledger ?? undefined,
    },
  } as unknown as contract.SentTransaction<any>;
}

/**
 * Sign and send a transaction via Launchtube
 * @param tx - The assembled transaction or XDR string
 * @param timeoutInSeconds - Timeout for the transaction
 * @param validUntilLedgerSeq - Valid until ledger sequence
 * @returns Transaction result
 */
export async function signAndSendViaLaunchtube(
  tx: contract.AssembledTransaction<any> | string,
  timeoutInSeconds: number = 30,
  signer?: RelayerSignerOptions,
  validUntilLedgerSeq?: number,
  options?: { direct?: boolean; bypassRelayer?: boolean }
): Promise<contract.SentTransaction<any>> {
  if (
    typeof tx !== 'string' &&
    'simulate' in tx &&
    DEAD_DROP_RELAYER_URL &&
    options?.bypassRelayer !== true
  ) {
    if (DEAD_DROP_DEBUG) {
      console.info('[TxHelper][submit] Using relayer path', {
        timeoutInSeconds,
        hasValidUntilLedgerSeq: typeof validUntilLedgerSeq === 'number',
        direct: options?.direct === true,
        bypassRelayer: Boolean(options?.bypassRelayer),
      });
    }
    try {
      return await submitViaRelayer(tx, signer, validUntilLedgerSeq, options);
    } catch (error) {
      if (DEAD_DROP_DEBUG) {
        console.warn('[TxHelper][submit] Relayer submit failed', { error });
      }
      if (!isTxBadSeqError(error)) throw error;

      // Retry once with a fresh simulation/build to refresh source account sequence.
      if (DEAD_DROP_DEBUG) {
        console.warn('[TxHelper][submit] Retrying after txBAD_SEQ with fresh simulation');
      }
      const refreshed = await tx.simulate();
      const retried = await submitViaRelayer(refreshed, signer, validUntilLedgerSeq, options);
      if (DEAD_DROP_DEBUG) {
        console.info('[TxHelper][submit] Retry after txBAD_SEQ succeeded', {
          status: (retried as any)?.getTransactionResponse?.status,
          hash: (retried as any)?.getTransactionResponse?.hash,
        });
      }
      return retried;
    }
  }

  // If tx is an AssembledTransaction, simulate and send
  if (typeof tx !== 'string' && 'simulate' in tx) {
    if (DEAD_DROP_DEBUG) {
      console.info('[TxHelper][submit] Using direct SDK signAndSend path', {
        bypassRelayer: options?.bypassRelayer === true,
      });
    }
    const simulated = await tx.simulate();
    try {
      return await simulated.signAndSend();
    } catch (err: any) {
      const errName = err?.name ?? '';
      const errMessage = err instanceof Error ? err.message : String(err);
      const isNoSignatureNeeded =
        errName.includes('NoSignatureNeededError') ||
        errMessage.includes('NoSignatureNeededError') ||
        errMessage.includes('This is a read call') ||
        errMessage.includes('requires no signature') ||
        errMessage.includes('force: true');

      // Some contract bindings incorrectly classify state-changing methods as "read calls".
      // In those cases, the SDK requires `force: true` to sign and send anyway.
      if (isNoSignatureNeeded) {
        try {
          return await simulated.signAndSend({ force: true });
        } catch (forceErr: any) {
          const forceName = forceErr?.name ?? '';
          const forceMessage = forceErr instanceof Error ? forceErr.message : String(forceErr);
          const isStillReadOnly =
            forceName.includes('NoSignatureNeededError') ||
            forceMessage.includes('NoSignatureNeededError') ||
            forceMessage.includes('This is a read call') ||
            forceMessage.includes('requires no signature');

          // If the SDK still says it's a read call, treat the simulation result as the final result.
          if (isStillReadOnly) {
            const simulatedResult =
              (simulated as any).result ??
              (simulated as any).simulationResult?.result ??
              (simulated as any).returnValue ??
              (tx as any).result;

            return {
              result: simulatedResult,
              getTransactionResponse: undefined,
            } as unknown as contract.SentTransaction<any>;
          }

          throw forceErr;
        }
      }

      throw err;
    }
  }

  // If tx is XDR string, it needs to be sent directly
  // This is typically used for multi-sig flows where the transaction is already built
  throw new Error('Direct XDR submission not yet implemented. Use AssembledTransaction.signAndSend() instead.');
}
