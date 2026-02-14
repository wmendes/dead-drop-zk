export interface ProvePingRequest {
  sessionId: number;
  turn: number;
  partialDx: number;
  partialDy: number;
  responderX: number;
  responderY: number;
  responderSaltHex: string;
  responderCommitmentHex: string;
}

export interface ProvePingResponse {
  distance: number;
  proofHex: string;
  publicInputsHex: string[];
}

function isLegacyResponderSchemaError(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes('a_x must be uint32')
    || normalized.includes('b_x must be uint32')
    || normalized.includes('commitment_a_hex')
    || normalized.includes('commitment_b_hex');
}

function formatLegacySchemaMismatchMessage(proverUrl: string): string {
  return [
    `Dead Drop prover API mismatch at ${proverUrl}.`,
    'Backend appears to use legacy combined-secret fields (a_x/b_x/etc).',
    'This frontend requires responder-only inputs: responder_x/responder_y plus partial_dx/partial_dy.',
    'Update and restart backend/dead-drop-prover from this repo, then retry Send Ping.',
  ].join(' ');
}

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
      partial_dx: req.partialDx,
      partial_dy: req.partialDy,
      responder_x: req.responderX,
      responder_y: req.responderY,
      responder_salt_hex: req.responderSaltHex,
      responder_commitment_hex: req.responderCommitmentHex,
    }),
  });

  if (!response.ok) {
    const message = await readProofServiceError(response);
    if (isLegacyResponderSchemaError(message)) {
      throw new Error(formatLegacySchemaMismatchMessage(normalizedProverUrl));
    }
    throw new Error(message);
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
