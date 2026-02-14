const { Address, rpc, xdr } = require("@stellar/stellar-sdk");

const DEFAULT_RPC_URL = "https://soroban-testnet.stellar.org";
const DEFAULT_CHANNELS_BASE_URL = "https://channels.openzeppelin.com/testnet";
const DEFAULT_POLL_ATTEMPTS = 20;

let cachedChannelsClient = null;

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function getRpcServer(rpcUrl) {
  return new rpc.Server(rpcUrl || process.env.SOROBAN_RPC_URL || DEFAULT_RPC_URL);
}

function normalizeBase64(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty base64 string`);
  }
  const trimmed = value.trim();

  // Accept base64url payloads and normalize to classic base64.
  let normalized = trimmed.replace(/-/g, "+").replace(/_/g, "/");
  const mod = normalized.length % 4;
  if (mod === 2) normalized += "==";
  if (mod === 3) normalized += "=";
  if (mod === 1) {
    throw new Error(`${label} has invalid base64 length`);
  }

  return normalized;
}

function parseXdrOrThrow(value, parserFn, label) {
  try {
    return parserFn(value);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`${label} is not valid XDR (${reason})`);
  }
}

function tryExtractHostFunction(value, label) {
  // 1) Direct host function XDR (expected shape)
  try {
    const hostFunction = xdr.HostFunction.fromXDR(value, "base64");
    return hostFunction.toXDR("base64");
  } catch {
    // continue
  }

  // 2) Operation XDR (invokeHostFunction op)
  try {
    const op = xdr.Operation.fromXDR(value, "base64");
    if (op.body().switch().name !== "invokeHostFunction") {
      throw new Error("operation body is not invokeHostFunction");
    }
    return op.body().invokeHostFunctionOp().hostFunction().toXDR("base64");
  } catch {
    // continue
  }

  // 3) TransactionEnvelope XDR (first operation invokeHostFunction)
  try {
    const envelope = xdr.TransactionEnvelope.fromXDR(value, "base64");
    const tx = envelope.v1().tx();
    const operations = tx.operations();
    if (!operations || operations.length === 0) {
      throw new Error("transaction envelope has no operations");
    }
    const first = operations[0];
    if (first.body().switch().name !== "invokeHostFunction") {
      throw new Error("first operation is not invokeHostFunction");
    }
    return first.body().invokeHostFunctionOp().hostFunction().toXDR("base64");
  } catch {
    // continue
  }

  // 4) Hex-encoded host function (for manual payloads/debugging)
  if (/^[0-9a-fA-F]+$/.test(value) && value.length % 2 === 0) {
    try {
      const hostFunction = xdr.HostFunction.fromXDR(value, "hex");
      return hostFunction.toXDR("base64");
    } catch {
      // continue
    }
  }

  throw new Error(
    `${label} is not valid HostFunction XDR. Expected HostFunction XDR (base64). Also tried Operation and TransactionEnvelope fallbacks.`
  );
}

async function getChannelsClient() {
  if (cachedChannelsClient) return cachedChannelsClient;

  let plugin;
  try {
    plugin = await import("@openzeppelin/relayer-plugin-channels");
  } catch (err) {
    throw new Error(
      "Missing dependency: @openzeppelin/relayer-plugin-channels. Install backend dependencies before using relayer mode."
    );
  }

  const ChannelsClient = plugin.ChannelsClient || plugin.default?.ChannelsClient;
  if (!ChannelsClient) {
    throw new Error("Failed to load ChannelsClient from @openzeppelin/relayer-plugin-channels");
  }

  const apiKey = requireEnv("OZ_RELAYER_API_KEY");
  const baseUrl = process.env.OZ_RELAYER_BASE_URL || DEFAULT_CHANNELS_BASE_URL;

  const client = new ChannelsClient({ baseUrl, apiKey });

  // Intercept raw HTTP errors BEFORE parseAxiosError() consumes them.
  // PluginUnexpectedError (thrown by validateResponse) has no .response property,
  // so this is the only place where HTTP status/body are visible.
  if (client.axiosClient?.interceptors?.response) {
    client.axiosClient.interceptors.response.use(
      (res) => res,
      (err) => {
        if (err?.response) {
          const status = err.response.status;
          const body = err.response.data;
          const preview = typeof body === "string" ? body.slice(0, 300) : JSON.stringify(body);
          console.error("[relayer] OZ Channels HTTP error status=%d body=%s", status, preview);
        }
        return Promise.reject(err);
      }
    );
  }

  cachedChannelsClient = client;
  return cachedChannelsClient;
}

function validateSubmitRequest(input) {
  const funcRaw = normalizeBase64(input.func_xdr, "func_xdr");
  const authEntriesXdr = Array.isArray(input.auth_entries_xdr)
    ? input.auth_entries_xdr.map((v, i) => normalizeBase64(v, `auth_entries_xdr[${i}]`))
    : [];

  const funcXdr = tryExtractHostFunction(funcRaw, "func_xdr");
  for (let i = 0; i < authEntriesXdr.length; i++) {
    parseXdrOrThrow(
      authEntriesXdr[i],
      (value) => xdr.SorobanAuthorizationEntry.fromXDR(value, "base64"),
      `auth_entries_xdr[${i}]`
    );
  }

  return {
    funcXdr,
    authEntriesXdr,
    rpcUrl: typeof input.rpc_url === "string" && input.rpc_url ? input.rpc_url : undefined,
  };
}

function formatRelayerError(err) {
  const baseMessage = err instanceof Error ? err.message : String(err);
  const details = err && typeof err === "object" ? err.errorDetails : undefined;
  if (details === undefined) {
    return baseMessage;
  }

  let detailsText = "";
  try {
    detailsText = JSON.stringify(details);
  } catch {
    detailsText = String(details);
  }

  return `${baseMessage} | details=${detailsText}`;
}

function summarizeAuthEntries(authEntriesXdr) {
  if (!Array.isArray(authEntriesXdr) || authEntriesXdr.length === 0) {
    return [];
  }

  return authEntriesXdr.map((entryXdr, index) => {
    try {
      const entry = xdr.SorobanAuthorizationEntry.fromXDR(entryXdr, "base64");
      const cred = entry.credentials();
      const credType = cred.switch().name;
      if (credType !== "sorobanCredentialsAddress") {
        return { index, credType };
      }

      const addrCred = cred.address();
      const address = Address.fromScAddress(addrCred.address()).toString();
      const signatureKind = addrCred.signature().switch().name;
      return { index, credType, address, signatureKind };
    } catch (err) {
      return {
        index,
        parseError: err instanceof Error ? err.message : String(err),
      };
    }
  });
}

async function submitSorobanViaRelayer(input) {
  const { funcXdr, authEntriesXdr, rpcUrl } = validateSubmitRequest(input);
  const channelsClient = await getChannelsClient();

  let response;
  try {
    response = await channelsClient.submitSorobanTransaction({
      func: funcXdr,
      auth: authEntriesXdr,
    });
  } catch (err) {
    const message = formatRelayerError(err);
    const authSummary = summarizeAuthEntries(authEntriesXdr);
    throw new Error(`Relayer submission failed: ${message} | auth=${JSON.stringify(authSummary)}`);
  }

  const hash = response?.hash;
  if (!hash || typeof hash !== "string") {
    throw new Error("Relayer response missing transaction hash");
  }

  const pollAttemptsRaw = Number(process.env.OZ_RELAYER_POLL_ATTEMPTS || DEFAULT_POLL_ATTEMPTS);
  const pollAttempts = Number.isInteger(pollAttemptsRaw) && pollAttemptsRaw > 0
    ? pollAttemptsRaw
    : DEFAULT_POLL_ATTEMPTS;

  const rpcServer = getRpcServer(rpcUrl);
  const txResult = await rpcServer.pollTransaction(hash, { attempts: pollAttempts });

  return {
    transaction_id: response?.transactionId || null,
    hash,
    status: txResult.status || response?.status || "UNKNOWN",
    ledger: txResult.ledger || null,
    return_value_xdr: txResult.returnValue ? txResult.returnValue.toXDR("base64") : null,
  };
}

module.exports = {
  submitSorobanViaRelayer,
  getRpcServer,
  normalizeBase64,
  tryExtractHostFunction,
};
