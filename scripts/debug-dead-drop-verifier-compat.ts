#!/usr/bin/env bun

import { readFile } from 'fs/promises';
import { createHash } from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { createRequire } from 'module';

const execFileAsync = promisify(execFile);
const requireFromRoot = createRequire(import.meta.url);

type Args = {
  proofPath?: string;
  publicPath?: string;
  vkeyPath?: string;
  json: boolean;
};

function usage() {
  console.log(`Usage:
  bun scripts/debug-dead-drop-verifier-compat.ts --proof <proof.json> --public <public.json> --vkey <vkey.json> [--json]

Compares:
  1) local snarkjs groth16 verify(vkey, public, proof)
  2) backend encoder.js proof/public bytes
  3) reference encoder bytes (proof/public/vk)
  4) backend encode_bn254.mjs vk bytes vs reference vk bytes
`);
}

function parseArgs(argv: string[]): Args {
  const out: Args = { json: false };
  const next = (i: number) => {
    const v = argv[i + 1];
    if (!v || v.startsWith('--')) throw new Error(`Missing value for ${argv[i]}`);
    return v;
  };
  for (let i = 0; i < argv.length; i += 1) {
    switch (argv[i]) {
      case '--help':
        usage();
        process.exit(0);
      case '--proof':
        out.proofPath = next(i); i += 1; break;
      case '--public':
        out.publicPath = next(i); i += 1; break;
      case '--vkey':
        out.vkeyPath = next(i); i += 1; break;
      case '--json':
        out.json = true; break;
      default:
        throw new Error(`Unknown arg: ${argv[i]}`);
    }
  }
  if (!out.proofPath || !out.publicPath || !out.vkeyPath) {
    usage();
    throw new Error('Missing --proof / --public / --vkey');
  }
  return out;
}

function sha256Hex(input: string | Buffer) {
  return createHash('sha256').update(input).digest('hex');
}

function normalizeHex(v: string) {
  return v.replace(/^0x/i, '').trim().toLowerCase();
}

async function readJson(filePath: string) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

async function runNode(scriptPath: string, args: string[]) {
  const { stdout, stderr } = await execFileAsync('node', [scriptPath, ...args], {
    cwd: process.cwd(),
    maxBuffer: 8 * 1024 * 1024,
  });
  return { stdout: stdout.trim(), stderr: stderr.trim() };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const proofPath = path.resolve(args.proofPath!);
  const publicPath = path.resolve(args.publicPath!);
  const vkeyPath = path.resolve(args.vkeyPath!);

  const [proofJson, publicJson, vkeyJson] = await Promise.all([
    readJson(proofPath),
    readJson(publicPath),
    readJson(vkeyPath),
  ]);

  const backendEncoder = requireFromRoot(path.resolve('backend/dead-drop-prover/encoder.js')) as {
    encodeProof: (proof: unknown) => string;
    encodePublic: (signals: unknown[]) => string;
  };

  // Run snarkjs verify under Node.js to avoid Bun web-worker incompatibility
  const verifyScript = `
    const snarkjs = require(${JSON.stringify(path.resolve('backend/dead-drop-prover/node_modules/snarkjs'))});
    const fs = require('fs');
    const vkey = JSON.parse(fs.readFileSync(${JSON.stringify(vkeyPath)}, 'utf8'));
    const pub = JSON.parse(fs.readFileSync(${JSON.stringify(publicPath)}, 'utf8'));
    const proof = JSON.parse(fs.readFileSync(${JSON.stringify(proofPath)}, 'utf8'));
    snarkjs.groth16.verify(vkey, pub, proof).then(ok => { console.log(JSON.stringify(ok)); process.exit(0); });
  `;
  const { stdout: verifyOut } = await execFileAsync('node', ['-e', verifyScript], {
    cwd: process.cwd(),
    maxBuffer: 8 * 1024 * 1024,
  });
  const verifyOk = JSON.parse(verifyOut.trim());

  const backendProofHex = normalizeHex(backendEncoder.encodeProof(proofJson));
  const backendPublicHex = normalizeHex(backendEncoder.encodePublic(publicJson));

  const referenceEncoder = path.resolve('noir-groth16-reference/scripts/encode_bn254_for_soroban.mjs');
  const backendVkEncoder = path.resolve('backend/dead-drop-prover/encode_bn254.mjs');

  const [refProof, refPublic, refVk, backendVk] = await Promise.all([
    runNode(referenceEncoder, ['proof', proofPath]),
    runNode(referenceEncoder, ['public', publicPath]),
    runNode(referenceEncoder, ['vk', vkeyPath]),
    runNode(backendVkEncoder, ['vk', vkeyPath]),
  ]);

  const refProofHex = normalizeHex(refProof.stdout);
  const refPublicHex = normalizeHex(refPublic.stdout);
  const refVkHex = normalizeHex(refVk.stdout);
  const backendVkHex = normalizeHex(backendVk.stdout);

  const report = {
    inputs: { proofPath, publicPath, vkeyPath },
    snarkjsVerify: verifyOk,
    proof: {
      backendLen: backendProofHex.length / 2,
      referenceLen: refProofHex.length / 2,
      sameBytes: backendProofHex === refProofHex,
      backendSha256: sha256Hex(Buffer.from(backendProofHex, 'hex')),
      referenceSha256: sha256Hex(Buffer.from(refProofHex, 'hex')),
      firstDiffNibble: backendProofHex === refProofHex ? null : [...backendProofHex].findIndex((c, i) => c !== refProofHex[i]),
    },
    publicSignals: {
      backendLen: backendPublicHex.length / 2,
      referenceLen: refPublicHex.length / 2,
      sameBytes: backendPublicHex === refPublicHex,
      backendSha256: sha256Hex(Buffer.from(backendPublicHex, 'hex')),
      referenceSha256: sha256Hex(Buffer.from(refPublicHex, 'hex')),
      firstDiffNibble: backendPublicHex === refPublicHex ? null : [...backendPublicHex].findIndex((c, i) => c !== refPublicHex[i]),
    },
    vk: {
      backendVkLen: backendVkHex.length / 2,
      referenceVkLen: refVkHex.length / 2,
      sameBytes: backendVkHex === refVkHex,
      backendVkSha256: sha256Hex(Buffer.from(backendVkHex, 'hex')),
      referenceVkSha256: sha256Hex(Buffer.from(refVkHex, 'hex')),
      firstDiffNibble: backendVkHex === refVkHex ? null : [...backendVkHex].findIndex((c, i) => c !== refVkHex[i]),
    },
    stderr: {
      refProof: refProof.stderr || null,
      refPublic: refPublic.stderr || null,
      refVk: refVk.stderr || null,
      backendVk: backendVk.stderr || null,
    },
  };

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log('snarkjs verify:', report.snarkjsVerify);
  console.log('proof bytes match:', report.proof.sameBytes, report.proof);
  console.log('public bytes match:', report.publicSignals.sameBytes, report.publicSignals);
  console.log('vk bytes match:', report.vk.sameBytes, report.vk);
}

main().catch((err) => {
  console.error('Fatal error:', err instanceof Error ? err.stack || err.message : err);
  process.exit(1);
});

