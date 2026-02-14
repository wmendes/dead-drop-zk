/**
 * Transaction helper utilities
 */

import { Address, authorizeEntry, contract, rpc, xdr } from '@stellar/stellar-sdk';
import { Buffer } from 'buffer';
import { DEAD_DROP_RELAYER_URL, RPC_URL } from './constants';

interface RelayerSubmitResponse {
  hash: string;
  status: string;
  ledger?: number | null;
  return_value_xdr?: string | null;
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

  if (typeof signer?.signAssembledTransaction === 'function') {
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

  // Guard rail: never submit unsigned smart-account auth entries to relayer.
  if (Array.isArray(op.auth)) {
    for (const entry of op.auth) {
      try {
        if (!entry || entry.credentials().switch().name !== 'sorobanCredentialsAddress') {
          continue;
        }
        const creds = entry.credentials().address();
        const authAddress = Address.fromScAddress(creds.address()).toString();
        if (authAddress.startsWith('C') && creds.signature().switch().name === 'scvVoid') {
          throw new Error(`Unsigned smart-account auth entry detected for ${authAddress}. Passkey signing did not run.`);
        }
      } catch (err) {
        if (err instanceof Error) throw err;
        throw new Error('Failed to validate auth entries before relayer submission.');
      }
    }
  }

  const endpoint = options?.direct ? '/tx/submit-direct' : '/tx/submit';
  const response = await fetch(`${normalizeRelayerBaseUrl(DEAD_DROP_RELAYER_URL)}${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      func_xdr: resolveRelayerFuncPayload(op),
      auth_entries_xdr: Array.isArray(op.auth) ? op.auth.map((entry: any) => entry.toXDR('base64')) : [],
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
  if (!payload || typeof payload.hash !== 'string' || !payload.hash) {
    throw new Error('Relayer response missing transaction hash');
  }

  if (payload.status !== 'SUCCESS') {
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
  options?: { direct?: boolean }
): Promise<contract.SentTransaction<any>> {
  if (typeof tx !== 'string' && 'simulate' in tx && DEAD_DROP_RELAYER_URL) {
    return submitViaRelayer(tx, signer, validUntilLedgerSeq, options);
  }

  // If tx is an AssembledTransaction, simulate and send
  if (typeof tx !== 'string' && 'simulate' in tx) {
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
