const http = require("node:http");
const { WebSocketServer } = require("ws");
const { Keypair, TransactionBuilder, BASE_FEE, Networks, Operation, xdr } = require("@stellar/stellar-sdk");
const { provePing } = require("./prover");
const { submitSorobanViaRelayer, getRpcServer, normalizeBase64, tryExtractHostFunction } = require("./relayer");

const PING_GRID_SIZE = 100;
const RELAY_TTL_MS = Number(process.env.DEAD_DROP_RELAY_TTL_MS || 120_000);
const RELAY_READY_GRACE_MS = Number(
  process.env.DEAD_DROP_RELAY_READY_GRACE_MS || 60_000
);

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type",
  };
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    ...corsHeaders(),
    "content-type": "application/json",
  });
  res.end(JSON.stringify(body));
}

function sendError(res, status, message) {
  sendJson(res, status, { error: message });
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString();
      if (body.length > 1_000_000) {
        reject(new Error("body too large"));
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("invalid json"));
      }
    });
    req.on("error", reject);
  });
}

function normalizeHex(value, label, expectedBytes) {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a hex string`);
  }
  const hex = value.startsWith("0x") ? value.slice(2) : value;
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) {
    throw new Error(`${label} must be valid hex`);
  }
  if (expectedBytes && hex.length !== expectedBytes * 2) {
    throw new Error(`${label} must be ${expectedBytes} bytes`);
  }
  return hex.toLowerCase();
}

function parseU32(value, label) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) {
    throw new Error(`${label} must be uint32`);
  }
  return n;
}

function parseSelector(value) {
  if (value === undefined || value === null || value === "") {
    return "";
  }
  return normalizeHex(value, "VERIFIER_SELECTOR_HEX", 4);
}

function parseAddress(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function relayKey(sessionId, turn) {
  return `${sessionId}:${turn}`;
}

function sanitizeRelayRequest(entry) {
  return {
    session_id: entry.session_id,
    turn: entry.turn,
    x: entry.x,
    y: entry.y,
    requester: entry.requester,
    responder: entry.responder,
    created_at_ms: entry.created_at_ms,
    expires_at_ms: entry.expires_at_ms,
  };
}

function sanitizeRelayProof(proof) {
  return {
    distance: proof.distance,
    image_id_hex: proof.image_id_hex,
    journal_sha256_hex: proof.journal_sha256_hex,
    seal_hex: proof.seal_hex,
  };
}

function pruneExpiredRelayEntries(relayStore) {
  const now = Date.now();
  for (const [key, entry] of relayStore.entries()) {
    if (entry.expires_at_ms <= now) {
      relayStore.delete(key);
    }
  }
}

function sendWsJson(ws, payload) {
  if (!ws || ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify(payload));
}

function createServer(options = {}) {
  const relayStore = options.relayStore || new Map();
  const webrtcPeersBySession = options.webrtcPeersBySession || new Map();

  function getSessionPeers(sessionId) {
    let peers = webrtcPeersBySession.get(sessionId);
    if (!peers) {
      peers = new Map();
      webrtcPeersBySession.set(sessionId, peers);
    }
    return peers;
  }

  function removeSessionIfEmpty(sessionId, peers) {
    if (peers.size === 0) {
      webrtcPeersBySession.delete(sessionId);
    }
  }

  function unregisterPeer(sessionId, player, ws) {
    const peers = webrtcPeersBySession.get(sessionId);
    if (!peers) return;
    const current = peers.get(player);
    if (current !== ws) return;
    peers.delete(player);
    for (const [otherPlayer, otherWs] of peers.entries()) {
      if (otherPlayer === player) continue;
      sendWsJson(otherWs, {
        type: "webrtc:peer-left",
        session_id: sessionId,
        player,
      });
    }
    removeSessionIfEmpty(sessionId, peers);
  }

  async function handleProvePing(req, res) {
    let body;
    try {
      body = await readJson(req);
    } catch (err) {
      sendError(res, 400, err.message);
      return;
    }

    let input;
    try {
      input = {
        session_id: parseU32(body.session_id, "session_id"),
        turn: parseU32(body.turn, "turn"),
        partial_dx: parseU32(body.partial_dx, "partial_dx"),
        partial_dy: parseU32(body.partial_dy, "partial_dy"),
        responder_x: parseU32(body.responder_x, "responder_x"),
        responder_y: parseU32(body.responder_y, "responder_y"),
        responder_salt_hex: normalizeHex(body.responder_salt_hex, "responder_salt_hex", 32),
        responder_commitment_hex: normalizeHex(body.responder_commitment_hex, "responder_commitment_hex", 32),
      };
    } catch (err) {
      sendError(res, 400, err.message);
      return;
    }

    if (
      input.partial_dx >= PING_GRID_SIZE
      || input.partial_dy >= PING_GRID_SIZE
      || input.responder_x >= PING_GRID_SIZE
      || input.responder_y >= PING_GRID_SIZE
    ) {
      sendError(res, 400, `partial/responder coordinates must be in [0, ${PING_GRID_SIZE - 1}]`);
      return;
    }

    try {
      const proof = await provePing(input);
      sendJson(res, 200, {
        distance: proof.distance,
        proof_hex: proof.proofHex,
        public_inputs_hex: proof.publicInputsHex,
      });
    } catch (err) {
      sendError(res, 500, err.message || "prove failed");
    }
  }

  async function handleSubmitTx(req, res) {
    let body;
    try {
      body = await readJson(req);
    } catch (err) {
      sendError(res, 400, err.message);
      return;
    }

    try {
      const result = await submitSorobanViaRelayer(body);
      sendJson(res, 200, result);
    } catch (err) {
      const message = err instanceof Error ? err.message : "relayer submission failed";
      sendError(res, 500, message);
    }
  }

  async function handleSubmitTxDirect(req, res) {
    let body;
    try {
      body = await readJson(req);
    } catch (err) {
      sendError(res, 400, err.message);
      return;
    }

    const secret = process.env.BACKEND_SOURCE_SECRET;
    if (!secret) {
      sendError(res, 500, "BACKEND_SOURCE_SECRET not set");
      return;
    }

    const rpcUrl = typeof body.rpc_url === "string" && body.rpc_url ? body.rpc_url : "(default)";
    const authCount = Array.isArray(body.auth_entries_xdr) ? body.auth_entries_xdr.length : 0;
    const funcLen = typeof body.func_xdr === "string" ? body.func_xdr.length : 0;
    console.log("[submit-direct] rpc=%s auth_entries=%d func_xdr_len=%d", rpcUrl, authCount, funcLen);

    try {
      const keypair = Keypair.fromSecret(secret);
      console.log("[submit-direct] fee-payer=%s", keypair.publicKey());

      const server = getRpcServer(body.rpc_url);

      console.log("[submit-direct] fetching account...");
      const account = await server.getAccount(keypair.publicKey());
      console.log("[submit-direct] account seq=%s", account.sequenceNumber());

      console.log("[submit-direct] parsing func_xdr...");
      const funcXdr = tryExtractHostFunction(normalizeBase64(body.func_xdr, "func_xdr"), "func_xdr");
      const hostFn = xdr.HostFunction.fromXDR(funcXdr, "base64");
      console.log("[submit-direct] func parsed ok");

      console.log("[submit-direct] parsing %d auth entries...", authCount);
      const authEntries = (body.auth_entries_xdr || []).map((e, i) =>
        xdr.SorobanAuthorizationEntry.fromXDR(normalizeBase64(e, `auth[${i}]`), "base64")
      );
      console.log("[submit-direct] auth entries parsed ok");

      const networkPassphrase = process.env.STELLAR_NETWORK_PASSPHRASE || Networks.TESTNET;
      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase,
      })
        .addOperation(Operation.invokeHostFunction({ func: hostFn, auth: authEntries }))
        .setTimeout(60)
        .build();
      console.log("[submit-direct] tx built, preparing (simulate+fee)...");

      const prepared = await server.prepareTransaction(tx);
      console.log("[submit-direct] prepareTransaction ok");
      prepared.sign(keypair);

      console.log("[submit-direct] sending transaction...");
      const sendResult = await server.sendTransaction(prepared);
      console.log("[submit-direct] sendTransaction status=%s hash=%s", sendResult.status, sendResult.hash);

      if (sendResult.status === "ERROR") {
        const detail = sendResult.errorResult
          ? sendResult.errorResult.toXDR("base64")
          : JSON.stringify(sendResult);
        console.error("[submit-direct] sendTransaction ERROR detail=%s", detail);
        sendError(res, 400, `Transaction submission failed: ${detail}`);
        return;
      }

      let txResult;
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        txResult = await server.getTransaction(sendResult.hash);
        console.log("[submit-direct] poll %d status=%s", i + 1, txResult.status);
        if (txResult.status !== "NOT_FOUND") break;
      }

      if (txResult?.status === "FAILED") {
        const resultMeta = txResult.resultMetaXdr
          ? (typeof txResult.resultMetaXdr === "string"
              ? txResult.resultMetaXdr
              : txResult.resultMetaXdr.toXDR("base64"))
          : "no meta";
        console.error("[submit-direct] tx FAILED resultMeta=%s", resultMeta);
      }

      const returnValueXdr = txResult?.returnValue
        ? txResult.returnValue.toXDR("base64")
        : null;

      console.log("[submit-direct] done status=%s ledger=%s", txResult?.status, txResult?.ledger);
      sendJson(res, 200, {
        hash: sendResult.hash,
        status: txResult?.status || "UNKNOWN",
        ledger: txResult?.ledger ?? null,
        return_value_xdr: returnValueXdr,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "direct submission failed";
      console.error("[submit-direct] EXCEPTION:", err);
      sendError(res, 500, message);
    }
  }

  async function handleRelayPingRequest(req, res) {
    let body;
    try {
      body = await readJson(req);
    } catch (err) {
      sendError(res, 400, err.message);
      return;
    }

    let input;
    try {
      input = {
        session_id: parseU32(body.session_id, "session_id"),
        turn: parseU32(body.turn, "turn"),
        x: parseU32(body.x, "x"),
        y: parseU32(body.y, "y"),
        requester: parseAddress(body.requester, "requester"),
        responder: parseAddress(body.responder, "responder"),
      };
      if (input.x >= PING_GRID_SIZE || input.y >= PING_GRID_SIZE) {
        throw new Error(`x and y must be less than ${PING_GRID_SIZE}`);
      }
      if (input.requester === input.responder) {
        throw new Error("requester and responder must differ");
      }
    } catch (err) {
      sendError(res, 400, err.message);
      return;
    }

    pruneExpiredRelayEntries(relayStore);
    const key = relayKey(input.session_id, input.turn);
    const existing = relayStore.get(key);
    if (existing) {
      const sameRequest =
        existing.requester === input.requester &&
        existing.responder === input.responder &&
        existing.x === input.x &&
        existing.y === input.y;
      if (!sameRequest) {
        sendError(res, 409, "relay slot already in use for this session/turn");
        return;
      }

      sendJson(res, 200, {
        status: existing.proof ? "ready" : "pending",
        request: sanitizeRelayRequest(existing),
        proof: existing.proof ? sanitizeRelayProof(existing.proof) : null,
      });
      return;
    }

    const now = Date.now();
    const entry = {
      ...input,
      created_at_ms: now,
      expires_at_ms: now + RELAY_TTL_MS,
      proof: null,
    };
    relayStore.set(key, entry);

    sendJson(res, 200, {
      status: "pending",
      request: sanitizeRelayRequest(entry),
      proof: null,
    });
  }

  async function handleRelayPingNext(req, res, url) {
    let sessionId;
    let responder;
    try {
      sessionId = parseU32(url.searchParams.get("session_id"), "session_id");
      responder = parseAddress(url.searchParams.get("responder"), "responder");
    } catch (err) {
      sendError(res, 400, err.message);
      return;
    }

    pruneExpiredRelayEntries(relayStore);

    let next = null;
    for (const entry of relayStore.values()) {
      if (entry.session_id !== sessionId) continue;
      if (entry.responder !== responder) continue;
      if (entry.proof) continue;
      if (!next || entry.created_at_ms < next.created_at_ms) {
        next = entry;
      }
    }

    sendJson(res, 200, {
      request: next ? sanitizeRelayRequest(next) : null,
    });
  }

  async function handleRelayPingRespond(req, res) {
    let body;
    try {
      body = await readJson(req);
    } catch (err) {
      sendError(res, 400, err.message);
      return;
    }

    let input;
    try {
      input = {
        session_id: parseU32(body.session_id, "session_id"),
        turn: parseU32(body.turn, "turn"),
        responder: parseAddress(body.responder, "responder"),
        distance: parseU32(body.distance, "distance"),
        image_id_hex: normalizeHex(body.image_id_hex, "image_id_hex", 32),
        journal_sha256_hex: normalizeHex(
          body.journal_sha256_hex,
          "journal_sha256_hex",
          32
        ),
        seal_hex: normalizeHex(body.seal_hex, "seal_hex"),
      };
    } catch (err) {
      sendError(res, 400, err.message);
      return;
    }

    pruneExpiredRelayEntries(relayStore);
    const key = relayKey(input.session_id, input.turn);
    const existing = relayStore.get(key);
    if (!existing) {
      sendError(res, 404, "relay request not found");
      return;
    }
    if (existing.responder !== input.responder) {
      sendError(res, 403, "responder does not match relay request");
      return;
    }

    const newProof = {
      distance: input.distance,
      image_id_hex: input.image_id_hex,
      journal_sha256_hex: input.journal_sha256_hex,
      seal_hex: input.seal_hex,
    };

    if (existing.proof) {
      const sameProof =
        existing.proof.distance === newProof.distance &&
        existing.proof.image_id_hex === newProof.image_id_hex &&
        existing.proof.journal_sha256_hex === newProof.journal_sha256_hex &&
        existing.proof.seal_hex === newProof.seal_hex;
      if (!sameProof) {
        sendError(res, 409, "relay proof already recorded for this session/turn");
        return;
      }
      sendJson(res, 200, { ok: true, status: "ready" });
      return;
    }

    existing.proof = newProof;
    existing.expires_at_ms = Date.now() + RELAY_READY_GRACE_MS;
    relayStore.set(key, existing);

    sendJson(res, 200, {
      ok: true,
      status: "ready",
      request: sanitizeRelayRequest(existing),
      proof: sanitizeRelayProof(newProof),
    });
  }

  async function handleRelayPingResult(req, res, url) {
    let sessionId;
    let turn;
    let requester;
    try {
      sessionId = parseU32(url.searchParams.get("session_id"), "session_id");
      turn = parseU32(url.searchParams.get("turn"), "turn");
      requester = parseAddress(url.searchParams.get("requester"), "requester");
    } catch (err) {
      sendError(res, 400, err.message);
      return;
    }

    pruneExpiredRelayEntries(relayStore);
    const existing = relayStore.get(relayKey(sessionId, turn));
    if (!existing) {
      sendJson(res, 200, { status: "not_found" });
      return;
    }
    if (existing.requester !== requester) {
      sendError(res, 403, "requester does not match relay request");
      return;
    }
    if (!existing.proof) {
      sendJson(res, 200, {
        status: "pending",
        request: sanitizeRelayRequest(existing),
      });
      return;
    }

    sendJson(res, 200, {
      status: "ready",
      request: sanitizeRelayRequest(existing),
      proof: sanitizeRelayProof(existing.proof),
    });
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://localhost");

    if (req.method === "OPTIONS") {
      res.writeHead(204, corsHeaders());
      res.end();
      return;
    }

    if (req.method === "GET" && url.pathname === "/") {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "POST" && url.pathname === "/prove/ping") {
      await handleProvePing(req, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/tx/submit") {
      await handleSubmitTx(req, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/tx/submit-direct") {
      await handleSubmitTxDirect(req, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/relay/ping/request") {
      await handleRelayPingRequest(req, res);
      return;
    }

    if (req.method === "GET" && url.pathname === "/relay/ping/next") {
      await handleRelayPingNext(req, res, url);
      return;
    }

    if (req.method === "POST" && url.pathname === "/relay/ping/respond") {
      await handleRelayPingRespond(req, res);
      return;
    }

    if (req.method === "GET" && url.pathname === "/relay/ping/result") {
      await handleRelayPingResult(req, res, url);
      return;
    }

    sendError(res, 404, "not found");
  });

  const wss = new WebSocketServer({ noServer: true });

  wss.on("connection", (ws, req) => {
    const sessionId = req.webrtcSessionId;
    const player = req.webrtcPlayer;

    if (!Number.isInteger(sessionId) || !player) {
      ws.close(1008, "invalid connection context");
      return;
    }

    const peers = getSessionPeers(sessionId);
    const existing = peers.get(player);
    if (existing && existing !== ws) {
      try {
        existing.close(4000, "replaced by newer connection");
      } catch {
        // no-op
      }
    }
    peers.set(player, ws);

    sendWsJson(ws, {
      type: "webrtc:ready",
      session_id: sessionId,
      player,
      peers: [...peers.keys()].filter((p) => p !== player),
    });

    for (const [otherPlayer, otherWs] of peers.entries()) {
      if (otherPlayer === player) continue;
      sendWsJson(otherWs, {
        type: "webrtc:peer-joined",
        session_id: sessionId,
        player,
      });
    }

    ws.on("message", (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        sendWsJson(ws, { type: "webrtc:error", error: "invalid json" });
        return;
      }

      const type = String(message?.type || "");
      const directTypes = new Set([
        "signal-offer",
        "signal-answer",
        "signal-ice",
        "app-direct",
      ]);

      if (type === "app-broadcast") {
        const event = String(message?.event || "");
        if (!event) {
          sendWsJson(ws, { type: "webrtc:error", error: "broadcast event is required" });
          return;
        }
        for (const [otherPlayer, otherWs] of peers.entries()) {
          if (otherPlayer === player) continue;
          sendWsJson(otherWs, {
            type: "app-broadcast",
            from: player,
            session_id: sessionId,
            event,
            payload: message?.payload ?? null,
          });
        }
        return;
      }

      if (!directTypes.has(type)) {
        sendWsJson(ws, { type: "webrtc:error", error: "unsupported message type" });
        return;
      }

      let targetPlayer;
      try {
        targetPlayer = parseAddress(message?.to, "to");
      } catch (err) {
        sendWsJson(ws, {
          type: "webrtc:error",
          error: err instanceof Error ? err.message : "invalid target player",
        });
        return;
      }

      const targetWs = peers.get(targetPlayer);
      if (!targetWs || targetWs.readyState !== targetWs.OPEN) {
        sendWsJson(ws, {
          type: "webrtc:error",
          error: `target peer not connected: ${targetPlayer}`,
        });
        return;
      }

      if (type === "app-direct") {
        const event = String(message?.event || "");
        if (!event) {
          sendWsJson(ws, { type: "webrtc:error", error: "direct event is required" });
          return;
        }
        sendWsJson(targetWs, {
          type: "app-direct",
          from: player,
          session_id: sessionId,
          event,
          payload: message?.payload ?? null,
        });
        return;
      }

      sendWsJson(targetWs, {
        type,
        from: player,
        session_id: sessionId,
        payload: message?.payload ?? null,
      });
    });

    ws.on("close", () => unregisterPeer(sessionId, player, ws));
    ws.on("error", () => unregisterPeer(sessionId, player, ws));
  });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url || "/", "http://localhost");
    if (url.pathname !== "/relay/webrtc") {
      socket.destroy();
      return;
    }

    let sessionId;
    let player;
    try {
      sessionId = parseU32(url.searchParams.get("session_id"), "session_id");
      player = parseAddress(url.searchParams.get("player"), "player");
    } catch (err) {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      socket.destroy();
      return;
    }

    req.webrtcSessionId = sessionId;
    req.webrtcPlayer = player;
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  return server;
}

module.exports = { createServer };
