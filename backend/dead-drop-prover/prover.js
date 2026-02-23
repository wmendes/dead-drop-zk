const fs = require("node:fs");
const path = require("node:path");
const { exec } = require("node:child_process");
const { promisify } = require("node:util");
const snarkjs = require("snarkjs");
const { encodeProof, encodePublic } = require("./encoder.js");

const execAsync = promisify(exec);

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

// Paths to Groth16 artifacts
const NOIR_CLI = path.resolve(__dirname, "../../noir-groth16-reference/target/release/noir-cli");
const CIRCUIT_JSON = path.resolve(__dirname, "../../circuits/dead_drop/target/dead_drop.json");
const ZKEY_PATH = process.env.GROTH16_ZKEY_PATH ||
  path.resolve(__dirname, "../../circuits/dead_drop/target/groth16/dead_drop_final.zkey");
const DEAD_DROP_PROVER_DEBUG_DUMP = process.env.DEAD_DROP_PROVER_DEBUG_DUMP === "1";

// ── Utilities ───────────────────────────────────────────────────────────────

function hexToBigInt(hex) {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  return BigInt("0x" + clean);
}

function toFieldHex(value) {
  return "0x" + BigInt(value).toString(16).padStart(64, "0");
}

function fieldHexNoPrefix(value) {
  return BigInt(value).toString(16).padStart(64, "0");
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

function decodeU32FieldHex(hex) {
  if (typeof hex !== "string" || !/^[0-9a-f]{64}$/i.test(hex)) {
    throw new Error(`invalid field hex: ${hex}`);
  }
  const n = BigInt("0x" + hex);
  if (n > 0xffffffffn) {
    throw new Error(`field value out of u32 range: 0x${hex}`);
  }
  return Number(n);
}

function decodePublicInputsSemantics(publicInputsHex) {
  if (!Array.isArray(publicInputsHex) || publicInputsHex.length !== 6) {
    throw new Error(`expected 6 public inputs, got ${Array.isArray(publicInputsHex) ? publicInputsHex.length : "non-array"}`);
  }

  return {
    session_id: decodeU32FieldHex(publicInputsHex[0]),
    turn: decodeU32FieldHex(publicInputsHex[1]),
    ping_x: decodeU32FieldHex(publicInputsHex[2]),
    ping_y: decodeU32FieldHex(publicInputsHex[3]),
    drop_commitment_hex: String(publicInputsHex[4]).toLowerCase(),
    expected_distance: decodeU32FieldHex(publicInputsHex[5]),
  };
}

function validatePublicInputsContractLayout(input, distance, publicInputsHex) {
  const expected = {
    session_id: input.session_id,
    turn: input.turn,
    ping_x: input.ping_x,
    ping_y: input.ping_y,
    drop_commitment_hex: String(input.drop_commitment_hex).toLowerCase(),
    expected_distance: distance,
  };

  const actual = decodePublicInputsSemantics(publicInputsHex);

  const matches = {
    session_id: actual.session_id === expected.session_id,
    turn: actual.turn === expected.turn,
    ping_x: actual.ping_x === expected.ping_x,
    ping_y: actual.ping_y === expected.ping_y,
    drop_commitment_hex: actual.drop_commitment_hex === expected.drop_commitment_hex,
    expected_distance: actual.expected_distance === expected.expected_distance,
  };

  const ok = Object.values(matches).every(Boolean);
  if (!ok) {
    console.error("[prover] Public input schema/value mismatch", {
      expected,
      actual,
      matches,
      publicInputsHex,
    });
    throw new Error(
      "Prover artifact/public input schema mismatch: generated public signals do not match Dead Drop contract layout " +
      "[session_id, turn, ping_x, ping_y, drop_commitment, expected_distance]. " +
      "Regenerate Groth16 artifacts (zkey/vkey) for the current circuit and update the verifier key on-chain."
    );
  }

  console.log("[prover] Public input layout verified", {
    session_id: actual.session_id,
    turn: actual.turn,
    ping_x: actual.ping_x,
    ping_y: actual.ping_y,
    drop_commitment_hex: actual.drop_commitment_hex,
    expected_distance: actual.expected_distance,
  });

  return { expected, actual, matches };
}

// ── Main export ────────────────────────────────────────────────────────────

/**
 * Generate a Groth16 proof for a Dead Drop ping.
 *
 * Input fields:
 *   session_id, turn, ping_x, ping_y
 *   drop_x, drop_y, drop_salt_hex
 *   drop_commitment_hex (32 bytes hex, no 0x)
 *
 * Returns: { distance, proofHex, publicInputsHex }
 */
async function provePing(input) {
  const distance = wrappedManhattan(
    input.ping_x,
    input.ping_y,
    input.drop_x,
    input.drop_y
  );

  // Reduce salts mod BN254_FR to get valid field elements.
  const dropSaltBigInt = hexToBigInt(input.drop_salt_hex) % BN254_FR;

  const witnessInput = {
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

  console.log(
    "[prover] Executing witness (session=%d turn=%d ping=(%d,%d) distance=%d)...",
    input.session_id,
    input.turn,
    input.ping_x,
    input.ping_y,
    distance
  );

  const inputPath = path.join(__dirname, "temp_input.json");
  const witnessDir = path.join(__dirname, "temp_witness");
  const witnessPath = path.join(witnessDir, "witness.wtns");

  try {
    // 1. Write witness input to temp file
    await fs.promises.mkdir(witnessDir, { recursive: true });
    await fs.promises.writeFile(inputPath, JSON.stringify(witnessInput));

    // 2. Generate witness using noir-cli
    const t0 = Date.now();
    try {
      await execAsync(
        `${NOIR_CLI} interop ${CIRCUIT_JSON} ${inputPath} --out ${witnessDir} --no-pedantic`
      );
    } catch (err) {
      console.error("[prover] Witness generation failed:", err.message);
      throw new Error(`Witness generation failed: ${err.message}`);
    }
    console.log("[prover] Witness done in %d ms", Date.now() - t0);

    // 3. Generate Groth16 proof with snarkjs
    console.log("[prover] Generating Groth16 proof...");
    const t1 = Date.now();
    const { proof, publicSignals } = await snarkjs.groth16.prove(
      ZKEY_PATH,
      witnessPath
    );
    console.log("[prover] Proof done in %d ms", Date.now() - t1);

    // 4. Encode for Soroban
    const proofHex = encodeProof(proof);
    const publicHex = encodePublic(publicSignals);

    // Parse publicHex: it's already encoded as concatenated 32-byte chunks
    // Format: [u32be(count) || field1 || field2 || ...]
    const publicBuf = Buffer.from(publicHex, "hex");
    const numPublic = publicBuf.readUInt32BE(0);
    const publicInputsHex = [];
    for (let i = 0; i < numPublic; i++) {
      const offset = 4 + i * 32;
      const chunk = publicBuf.subarray(offset, offset + 32);
      publicInputsHex.push(chunk.toString("hex"));
    }

    if (DEAD_DROP_PROVER_DEBUG_DUMP) {
      const debugDir = path.join(__dirname, "debug_artifacts");
      await fs.promises.mkdir(debugDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const base = `session-${input.session_id}-turn-${input.turn}-ping-${input.ping_x}-${input.ping_y}-${stamp}`;
      const proofJsonPath = path.join(debugDir, `${base}.proof.json`);
      const publicJsonPath = path.join(debugDir, `${base}.public.json`);
      const proofHexPath = path.join(debugDir, `${base}.proof.hex`);
      const publicHexPath = path.join(debugDir, `${base}.public.hex`);
      await Promise.all([
        fs.promises.writeFile(proofJsonPath, JSON.stringify(proof, null, 2)),
        fs.promises.writeFile(publicJsonPath, JSON.stringify(publicSignals, null, 2)),
        fs.promises.writeFile(proofHexPath, `${proofHex}\n`),
        fs.promises.writeFile(publicHexPath, `${publicHex}\n`),
      ]);
      console.log("[prover] Debug proof dump", {
        zkey_path: ZKEY_PATH,
        circuit_json: CIRCUIT_JSON,
        witness_input: witnessInput,
        proof_json_path: proofJsonPath,
        public_json_path: publicJsonPath,
        proof_hex_path: proofHexPath,
        public_hex_path: publicHexPath,
        encoded_proof_hex_len: proofHex.length,
        encoded_public_hex_len: publicHex.length,
        encoded_proof_sha256: require("node:crypto").createHash("sha256").update(Buffer.from(proofHex, "hex")).digest("hex"),
        encoded_public_sha256: require("node:crypto").createHash("sha256").update(Buffer.from(publicHex, "hex")).digest("hex"),
      });
    }

    validatePublicInputsContractLayout(input, distance, publicInputsHex);

    return { distance, proofHex, publicInputsHex };
  } finally {
    try { await fs.promises.unlink(inputPath); } catch {}
    try { await fs.promises.unlink(witnessPath); } catch {}
  }
}

async function selfCheckProverArtifacts() {
  const sample = {
    session_id: 42424242,
    turn: 7,
    ping_x: 37,
    ping_y: 42,
    drop_x: 92,
    drop_y: 99,
    drop_salt_hex: fieldHexNoPrefix(123456789n),
  };
  const drop_commitment_hex = computeDropCommitment(sample.drop_x, sample.drop_y, sample.drop_salt_hex);
  console.log("[prover] Running startup artifact self-check...");
  const result = await provePing({ ...sample, drop_commitment_hex });
  const decoded = decodePublicInputsSemantics(result.publicInputsHex);
  console.log("[prover] Startup artifact self-check passed", {
    session_id: decoded.session_id,
    turn: decoded.turn,
    ping_x: decoded.ping_x,
    ping_y: decoded.ping_y,
    drop_commitment_hex: decoded.drop_commitment_hex,
    expected_distance: decoded.expected_distance,
  });
  return true;
}

module.exports = {
  provePing,
  computeDropCommitment,
  selfCheckProverArtifacts,
  // exported for debugging/tests
  decodePublicInputsSemantics,
  validatePublicInputsContractLayout,
};
