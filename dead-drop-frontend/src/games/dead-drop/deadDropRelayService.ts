export interface RelayProofArtifacts {
  distance: number;
  proofHex: string;
  publicInputsHex: string[];
}

export interface RelayPingRequestInput {
  sessionId: number;
  turn: number;
  x: number;
  y: number;
  requesterAddress: string;
  responderAddress: string;
}

export interface RelayPendingPingRequest {
  sessionId: number;
  turn: number;
  x: number;
  y: number;
  requesterAddress: string;
  responderAddress: string;
}

export interface RelayPingResponseInput {
  sessionId: number;
  turn: number;
  responderAddress: string;
  proof: RelayProofArtifacts;
}

export interface RelayWaitOptions {
  sessionId: number;
  turn: number;
  requesterAddress: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
}

function baseUrl(raw: string): string {
  return raw.replace(/\/$/, "");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeHex(value: string, field: string): string {
  const hex = value.startsWith("0x") ? value.slice(2) : value;
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) {
    throw new Error(`Invalid ${field} hex value`);
  }
  return hex.toLowerCase();
}

async function readErrorMessage(response: Response): Promise<string> {
  const body = await response.json().catch(() => null);
  if (body && typeof body.error === "string" && body.error) {
    return body.error;
  }
  return `Relay request failed (${response.status})`;
}

function parseRelayProof(raw: any): RelayProofArtifacts {
  const distance = Number(raw?.distance);
  if (!Number.isInteger(distance) || distance < 0) {
    throw new Error("Relay proof contains invalid distance");
  }

  const proofHex = normalizeHex(String(raw?.proof_hex || ""), "proof_hex");
  const rawInputs = raw?.public_inputs_hex;
  if (!Array.isArray(rawInputs)) {
    throw new Error("Relay proof is missing public_inputs_hex array");
  }
  const publicInputsHex = rawInputs.map((h: string, i: number) =>
    normalizeHex(String(h), `public_inputs_hex[${i}]`)
  );

  return {
    distance,
    proofHex,
    publicInputsHex,
  };
}

function parseRelayRequest(raw: any): RelayPendingPingRequest | null {
  if (!raw) return null;
  const sessionId = Number(raw.session_id);
  const turn = Number(raw.turn);
  const x = Number(raw.x);
  const y = Number(raw.y);
  const requesterAddress = String(raw.requester || "");
  const responderAddress = String(raw.responder || "");

  if (
    !Number.isInteger(sessionId) ||
    !Number.isInteger(turn) ||
    !Number.isInteger(x) ||
    !Number.isInteger(y) ||
    !requesterAddress ||
    !responderAddress
  ) {
    throw new Error("Relay response contains invalid request payload");
  }

  return {
    sessionId,
    turn,
    x,
    y,
    requesterAddress,
    responderAddress,
  };
}

export async function enqueueRelayPingRequest(
  proverUrl: string,
  req: RelayPingRequestInput
): Promise<{ status: "pending" | "ready"; proof: RelayProofArtifacts | null }> {
  const response = await fetch(`${baseUrl(proverUrl)}/relay/ping/request`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      session_id: req.sessionId,
      turn: req.turn,
      x: req.x,
      y: req.y,
      requester: req.requesterAddress,
      responder: req.responderAddress,
    }),
  });

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }

  const data = await response.json();
  const status = data?.status === "ready" ? "ready" : "pending";
  const proof = status === "ready" && data?.proof
    ? parseRelayProof(data.proof)
    : null;
  return { status, proof };
}

export async function fetchRelayPendingPingRequest(
  proverUrl: string,
  sessionId: number,
  responderAddress: string
): Promise<RelayPendingPingRequest | null> {
  const qs = new URLSearchParams({
    session_id: String(sessionId),
    responder: responderAddress,
  });
  const response = await fetch(`${baseUrl(proverUrl)}/relay/ping/next?${qs}`);
  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }

  const data = await response.json();
  return parseRelayRequest(data?.request);
}

export async function submitRelayPingResponse(
  proverUrl: string,
  input: RelayPingResponseInput
): Promise<void> {
  const response = await fetch(`${baseUrl(proverUrl)}/relay/ping/respond`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      session_id: input.sessionId,
      turn: input.turn,
      responder: input.responderAddress,
      distance: input.proof.distance,
      proof_hex: input.proof.proofHex,
      public_inputs_hex: input.proof.publicInputsHex,
    }),
  });

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }
}

export async function waitForRelayPingProof(
  proverUrl: string,
  options: RelayWaitOptions
): Promise<RelayProofArtifacts> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const pollIntervalMs = options.pollIntervalMs ?? 1_500;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() <= deadline) {
    const qs = new URLSearchParams({
      session_id: String(options.sessionId),
      turn: String(options.turn),
      requester: options.requesterAddress,
    });

    const response = await fetch(`${baseUrl(proverUrl)}/relay/ping/result?${qs}`);
    if (!response.ok) {
      throw new Error(await readErrorMessage(response));
    }

    const data = await response.json();
    const status = String(data?.status || "pending");
    if (status === "ready") {
      return parseRelayProof(data?.proof);
    }
    if (status === "expired") {
      throw new Error("Relay request expired before opponent responded");
    }

    await sleep(pollIntervalMs);
  }

  throw new Error("Timed out waiting for opponent proof");
}
