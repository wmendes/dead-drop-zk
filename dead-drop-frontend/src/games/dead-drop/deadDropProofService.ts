export interface SessionRandomnessArtifacts {
  sessionId: number;
  randomnessOutputHex: string;
  randomnessSignatureHex: string;
  dropCommitmentHex: string;
}

export interface ProvePingRequest {
  sessionId: number;
  turn: number;
  pingX: number;
  pingY: number;
}

export interface ProvePingResponse {
  distance: number;
  proofHex: string;
  publicInputsHex: string[];
}

const DEAD_DROP_DEBUG = import.meta.env.DEV || import.meta.env.VITE_DEAD_DROP_DEBUG === 'true';

async function readProofServiceError(response: Response): Promise<string> {
  const fallback = `Proof service failed (${response.status})`;
  const raw = await response.text().catch(() => '');
  if (!raw) return fallback;

  try {
    const parsed = JSON.parse(raw) as { error?: unknown };
    if (typeof parsed.error === 'string' && parsed.error) {
      return parsed.error;
    }
  } catch {
    // Non-JSON response body.
  }

  return raw || fallback;
}

function ensureHex(value: unknown, label: string, expectedBytes?: number): string {
  if (typeof value !== 'string' || !value) {
    throw new Error(`Proof service returned missing ${label}`);
  }
  const normalized = value.replace(/^0x/, '').toLowerCase();
  if (!/^[0-9a-f]+$/.test(normalized) || normalized.length % 2 !== 0) {
    throw new Error(`Proof service returned invalid ${label}`);
  }
  if (expectedBytes && normalized.length !== expectedBytes * 2) {
    throw new Error(`Proof service returned invalid ${label} length`);
  }
  return normalized;
}

export async function getSessionRandomness(
  proverUrl: string,
  sessionId: number,
): Promise<SessionRandomnessArtifacts> {
  const normalizedProverUrl = proverUrl.replace(/\/$/, '');
  if (DEAD_DROP_DEBUG) {
    console.info('[DeadDropProof][randomness] Request start', {
      proverUrl: normalizedProverUrl,
      sessionId,
    });
  }
  const response = await fetch(`${normalizedProverUrl}/randomness/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: sessionId }),
  });

  if (DEAD_DROP_DEBUG) {
    console.info('[DeadDropProof][randomness] Response received', {
      status: response.status,
      ok: response.ok,
      sessionId,
    });
  }

  if (!response.ok) {
    throw new Error(await readProofServiceError(response));
  }

  const data = await response.json();
  const parsedSessionId = Number(data.session_id);
  if (!Number.isInteger(parsedSessionId) || parsedSessionId !== sessionId) {
    throw new Error('Proof service returned unexpected session_id');
  }
  const artifacts = {
    sessionId: parsedSessionId,
    randomnessOutputHex: ensureHex(data.randomness_output_hex, 'randomness_output_hex', 32),
    randomnessSignatureHex: ensureHex(data.randomness_signature_hex, 'randomness_signature_hex', 64),
    dropCommitmentHex: ensureHex(data.drop_commitment_hex, 'drop_commitment_hex', 32),
  };

  if (DEAD_DROP_DEBUG) {
    console.info('[DeadDropProof][randomness] Parsed artifacts', {
      requestedSessionId: sessionId,
      returnedSessionId: artifacts.sessionId,
      randomnessOutputHexLength: artifacts.randomnessOutputHex.length,
      dropCommitmentHexLength: artifacts.dropCommitmentHex.length,
      randomnessSignatureHexLength: artifacts.randomnessSignatureHex.length,
      randomnessOutputHex: artifacts.randomnessOutputHex,
      dropCommitmentHex: artifacts.dropCommitmentHex,
      randomnessSignatureHex: artifacts.randomnessSignatureHex,
    });
  }

  return artifacts;
}

export async function provePing(
  proverUrl: string,
  req: ProvePingRequest,
): Promise<ProvePingResponse> {
  const normalizedProverUrl = proverUrl.replace(/\/$/, '');
  const response = await fetch(`${normalizedProverUrl}/prove/ping`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      session_id: req.sessionId,
      turn: req.turn,
      ping_x: req.pingX,
      ping_y: req.pingY,
    }),
  });

  if (!response.ok) {
    throw new Error(await readProofServiceError(response));
  }

  const data = await response.json();

  const distance = Number(data.distance);
  if (!Number.isInteger(distance) || distance < 0) {
    throw new Error('Proof service returned invalid distance');
  }

  if (typeof data.proof_hex !== 'string' || !data.proof_hex) {
    throw new Error('Proof service returned missing proof_hex');
  }
  if (!Array.isArray(data.public_inputs_hex)) {
    throw new Error('Proof service returned missing public_inputs_hex');
  }
  if (data.public_inputs_hex.length !== 6) {
    throw new Error(
      `Dead Drop prover API mismatch at ${normalizedProverUrl}. ` +
      `Expected 6 public inputs, got ${data.public_inputs_hex.length}.`
    );
  }

  return {
    distance,
    proofHex: data.proof_hex,
    publicInputsHex: data.public_inputs_hex as string[],
  };
}
