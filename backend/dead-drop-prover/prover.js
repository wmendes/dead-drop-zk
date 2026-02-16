const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
let poseidon2Hash;
try {
  ({ poseidon2Hash } = require("@zkpassport/poseidon2"));
} catch {
  // Reuse frontend-installed dependency in monorepo setups.
  ({ poseidon2Hash } = require("../../dead-drop-frontend/node_modules/@zkpassport/poseidon2"));
}

// BN254 scalar field prime — must match deadDropNoirService.ts
const BN254_FR = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const GRID_SIZE = 100;

// Circuit artifact, loaded once at startup.
const CIRCUIT_PATH = path.resolve(
  __dirname,
  "..",
  "..",
  "circuits",
  "dead_drop",
  "target",
  "dead_drop.json"
);
const circuit = JSON.parse(fs.readFileSync(CIRCUIT_PATH, "utf-8"));

// Lazy singleton instances — WASM init (~10-30 s) happens once per process.
let _noir = null;
let _backend = null;

async function getInstances() {
  if (!_noir || !_backend) {
    console.log("[prover] Initialising Noir WASM (first call)...");
    const t = Date.now();
    const { Noir } = await import("@noir-lang/noir_js");
    const { UltraHonkBackend } = await import("@aztec/bb.js");
    _backend = new UltraHonkBackend(circuit.bytecode, {
      threads: os.cpus().length,
    });
    _noir = new Noir(circuit);
    console.log("[prover] WASM ready in %d ms", Date.now() - t);
  }
  return { noir: _noir, backend: _backend };
}

// ── Utilities ───────────────────────────────────────────────────────────────

function hexToBigInt(hex) {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  return BigInt("0x" + clean);
}

function toFieldHex(value) {
  return "0x" + BigInt(value).toString(16).padStart(64, "0");
}

function wrappedManhattan(px, py, rx, ry) {
  const dx = Math.abs(px - rx);
  const dy = Math.abs(py - ry);
  return Math.min(dx, GRID_SIZE - dx) + Math.min(dy, GRID_SIZE - dy);
}

function computeDropCommitment(dropX, dropY, dropSaltHex) {
  const saltBigInt = hexToBigInt(dropSaltHex) % BN254_FR;
  const result = poseidon2Hash([BigInt(dropX), BigInt(dropY), saltBigInt]);
  return result.toString(16).padStart(64, "0");
}

// ── Main export ────────────────────────────────────────────────────────────

/**
 * Generate a Noir UltraHonk proof for a Dead Drop ping.
 *
 * Input fields:
 *   session_id, turn, ping_x, ping_y
 *   drop_x, drop_y, drop_salt_hex
 *   drop_commitment_hex (32 bytes hex, no 0x)
 *
 * Returns: { distance, proofHex, publicInputsHex }
 */
async function provePing(input) {
  const { noir, backend } = await getInstances();

  const distance = wrappedManhattan(
    input.ping_x,
    input.ping_y,
    input.drop_x,
    input.drop_y
  );

  // Reduce salts mod BN254_FR to get valid field elements.
  const dropSaltBigInt = hexToBigInt(input.drop_salt_hex) % BN254_FR;

  const witnessInputNew = {
    // Private inputs
    drop_x: String(input.drop_x),
    drop_y: String(input.drop_y),
    drop_salt: toFieldHex(dropSaltBigInt),
    // Public inputs
    session_id: String(input.session_id),
    turn: String(input.turn),
    ping_x: String(input.ping_x),
    ping_y: String(input.ping_y),
    expected_commitment: "0x" + input.drop_commitment_hex,
    expected_distance: String(distance),
  };

  // Backward-compatible mapping for older compiled artifacts.
  const witnessInputLegacy = {
    // Private inputs
    responder_x: String(input.drop_x),
    responder_y: String(input.drop_y),
    responder_salt: toFieldHex(dropSaltBigInt),
    // Public inputs
    session_id: String(input.session_id),
    turn: String(input.turn),
    partial_dx: String(input.ping_x),
    partial_dy: String(input.ping_y),
    expected_commitment: "0x" + input.drop_commitment_hex,
    expected_distance: String(distance),
  };

  console.log(
    "[prover] Executing witness (session=%d turn=%d ping=(%d,%d) distance=%d)...",
    input.session_id,
    input.turn,
    input.ping_x,
    input.ping_y,
    distance
  );
  const t0 = Date.now();
  let witness;
  try {
    ({ witness } = await noir.execute(witnessInputNew));
  } catch (newSchemaErr) {
    try {
      ({ witness } = await noir.execute(witnessInputLegacy));
    } catch {
      throw newSchemaErr;
    }
  }
  console.log("[prover] Witness done in %d ms", Date.now() - t0);

  console.log("[prover] Generating proof...");
  const t1 = Date.now();
  const proof = await backend.generateProof(witness);
  console.log("[prover] Proof done in %d ms", Date.now() - t1);

  const proofHex = Buffer.from(proof.proof).toString("hex");
  const publicInputsHex = proof.publicInputs.map((pi) => {
    const cleaned = pi.startsWith("0x") ? pi.slice(2) : pi;
    return cleaned.padStart(64, "0");
  });

  return { distance, proofHex, publicInputsHex };
}

module.exports = { provePing, computeDropCommitment };
