/**
 * BN254 Encoder for Groth16 Proofs to Soroban Format
 * TypeScript version of backend/dead-drop-prover/encoder.js
 */

const BN254_FR = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const BN254_FQ = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;

function toBigInt(value: any): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isInteger(value)) {
      throw new Error(`non-integer numeric field element: ${value}`);
    }
    return BigInt(value);
  }
  if (typeof value === "string") {
    if (value.startsWith("0x") || value.startsWith("0X")) {
      return BigInt(value);
    }
    return BigInt(value);
  }
  if (Array.isArray(value) && value.length === 3) {
    // If it's already a coordinate array [x, y, z], recursively convert each
    if (typeof value[0] === "string" && typeof value[1] === "string" && typeof value[2] === "string") {
      return toBigInt(value[0]);
    }
    // snarkjs fraction format: ["num", "den", radix]
    const num = BigInt(value[0]);
    const den = BigInt(value[1]);
    if (den !== 1n) {
      throw new Error(`cannot encode fraction field element ${value}`);
    }
    return num;
  }
  throw new Error(`unsupported field element type: ${typeof value} (value: ${JSON.stringify(value)})`);
}

function fieldToBe32(value: any): Uint8Array {
  const n = toBigInt(value);
  if (n >= BN254_FR) {
    throw new Error(`field element ${n} >= modulus ${BN254_FR}`);
  }
  const hex = n.toString(16).padStart(64, "0");
  return hexToBytes(hex);
}

function u32be(value: number): Uint8Array {
  const buf = new Uint8Array(4);
  buf[0] = (value >> 24) & 0xff;
  buf[1] = (value >> 16) & 0xff;
  buf[2] = (value >> 8) & 0xff;
  buf[3] = value & 0xff;
  return buf;
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const totalLength = arrays.reduce((sum, arr) => sum + arr.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

function encodeG1(point: any, label: string): Uint8Array {
  if (Array.isArray(point) && point.length === 3) {
    // snarkjs format: [x_string, y_string, z_string]
    const x = BigInt(point[0]);
    const y = BigInt(point[1]);
    const z = BigInt(point[2]);

    if (z === 0n) {
      // Point at infinity
      return concatBytes(
        new Uint8Array(32),
        new Uint8Array(32),
        new Uint8Array([0x01])
      );
    }
    if (z !== 1n) {
      throw new Error(`${label}: non-affine G1 point (z=${z})`);
    }
    if (x >= BN254_FQ || y >= BN254_FQ) {
      throw new Error(`${label}: G1 coordinate >= modulus`);
    }

    const xBuf = hexToBytes(x.toString(16).padStart(64, "0"));
    const yBuf = hexToBytes(y.toString(16).padStart(64, "0"));
    return concatBytes(xBuf, yBuf, new Uint8Array([0x00]));
  }
  throw new Error(`${label}: invalid G1 point format (${JSON.stringify(point)})`);
}

function encodeG2(point: any, label: string): Uint8Array {
  if (Array.isArray(point) && point.length === 3) {
    const x = point[0];
    const y = point[1];
    const z = point[2];

    // snarkjs format: [[x0_string, x1_string], [y0_string, y1_string], [z0_string, z1_string]]
    if (!Array.isArray(x) || !Array.isArray(y) || !Array.isArray(z)) {
      throw new Error(`${label}: invalid G2 format - coordinates must be arrays (${JSON.stringify(point)})`);
    }

    const z0 = BigInt(z[0]);
    const z1 = BigInt(z[1]);

    if (z0 === 0n && z1 === 0n) {
      // Point at infinity
      return concatBytes(
        new Uint8Array(64),
        new Uint8Array(64),
        new Uint8Array([0x01])
      );
    }
    if (z0 !== 1n || z1 !== 0n) {
      throw new Error(`${label}: non-affine G2 point (z=[${z0}, ${z1}])`);
    }

    // x and y are Fp2 elements [c0, c1]
    if (x.length !== 2 || y.length !== 2) {
      throw new Error(`${label}: invalid G2 Fp2 format - must have 2 elements`);
    }

    const x0 = BigInt(x[0]);
    const x1 = BigInt(x[1]);
    const y0 = BigInt(y[0]);
    const y1 = BigInt(y[1]);

    if (x0 >= BN254_FQ || x1 >= BN254_FQ || y0 >= BN254_FQ || y1 >= BN254_FQ) {
      throw new Error(`${label}: G2 coordinate >= modulus`);
    }

    // Encode as [x1, x0, y1, y0] (note the reversed order for Fp2)
    const x1Buf = hexToBytes(x1.toString(16).padStart(64, "0"));
    const x0Buf = hexToBytes(x0.toString(16).padStart(64, "0"));
    const y1Buf = hexToBytes(y1.toString(16).padStart(64, "0"));
    const y0Buf = hexToBytes(y0.toString(16).padStart(64, "0"));

    return concatBytes(x1Buf, x0Buf, y1Buf, y0Buf, new Uint8Array([0x00]));
  }
  throw new Error(`${label}: invalid G2 point format (${JSON.stringify(point)})`);
}

export function encodeProof(proof: any): string {
  const bytes = concatBytes(
    encodeG1(proof.pi_a, "pi_a"),
    encodeG2(proof.pi_b, "pi_b"),
    encodeG1(proof.pi_c, "pi_c")
  );
  return bytesToHex(bytes);
}

export function encodePublic(publicSignals: any[]): string {
  if (!Array.isArray(publicSignals)) {
    throw new Error("public signals must be an array");
  }
  const chunks = publicSignals.map((value) => fieldToBe32(value));
  const bytes = concatBytes(u32be(publicSignals.length), ...chunks);
  return bytesToHex(bytes);
}
