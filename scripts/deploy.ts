#!/usr/bin/env bun

/**
 * Deploy script for Soroban contracts to testnet
 *
 * Deploys Soroban contracts to testnet
 * Returns the deployed contract IDs
 */

import { $ } from "bun";
import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readEnvFile, getEnvValue } from './utils/env';
import { getWorkspaceContracts, listContractNames, selectContracts } from "./utils/contracts";

type StellarKeypair = {
  publicKey(): string;
  secret(): string;
};

type StellarKeypairFactory = {
  random(): StellarKeypair;
  fromSecret(secret: string): StellarKeypair;
};

async function loadKeypairFactory(): Promise<StellarKeypairFactory> {
  try {
    const sdk = await import("@stellar/stellar-sdk");
    return sdk.Keypair;
  } catch (error) {
    console.warn("⚠️  @stellar/stellar-sdk is not installed. Running `bun install`...");
    try {
      await $`bun install`;
      const sdk = await import("@stellar/stellar-sdk");
      return sdk.Keypair;
    } catch (installError) {
      console.error("❌ Failed to load @stellar/stellar-sdk.");
      console.error("Run `bun install` in the repository root, then retry.");
      process.exit(1);
    }
  }
}

function usage() {
  console.log(`
Usage: bun run deploy [contract-name...]

Examples:
  bun run deploy
  bun run deploy number-guess
  bun run deploy twenty-one number-guess
`);
}

console.log("🚀 Deploying contracts to Stellar testnet...\n");
const Keypair = await loadKeypairFactory();

const NETWORK = 'testnet';
const RPC_URL = 'https://soroban-testnet.stellar.org';
const NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015';
const EXISTING_GAME_HUB_TESTNET_CONTRACT_ID = 'CB4VZAT2U3UC6XFK3N23SKRF2NDCMP3QHJYMCHHFMZO7MRQO6DQ2EMYG';

async function testnetAccountExists(address: string): Promise<boolean> {
  const res = await fetch(`https://horizon-testnet.stellar.org/accounts/${address}`, { method: 'GET' });
  if (res.status === 404) return false;
  if (!res.ok) throw new Error(`Horizon error ${res.status} checking ${address}`);
  return true;
}

async function ensureTestnetFunded(address: string): Promise<void> {
  if (await testnetAccountExists(address)) return;
  console.log(`💰 Funding ${address} via friendbot...`);
  const fundRes = await fetch(`https://friendbot.stellar.org?addr=${address}`, { method: 'GET' });
  if (!fundRes.ok) {
    throw new Error(`Friendbot funding failed (${fundRes.status}) for ${address}`);
  }
  for (let attempt = 0; attempt < 5; attempt++) {
    await new Promise((r) => setTimeout(r, 750));
    if (await testnetAccountExists(address)) return;
  }
  throw new Error(`Funded ${address} but it still doesn't appear on Horizon yet`);
}

async function testnetContractExists(contractId: string): Promise<boolean> {
  const tmpPath = join(tmpdir(), `stellar-contract-${contractId}.wasm`);
  try {
    await $`stellar -q contract fetch --id ${contractId} --network ${NETWORK} --out-file ${tmpPath}`;
    return true;
  } catch {
    return false;
  } finally {
    try {
      await unlink(tmpPath);
    } catch {
      // Ignore missing temp file
    }
  }
}

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  usage();
  process.exit(0);
}

const allContracts = await getWorkspaceContracts();
const selection = selectContracts(allContracts, args);
if (selection.unknown.length > 0 || selection.ambiguous.length > 0) {
  console.error("❌ Error: Unknown or ambiguous contract names.");
  if (selection.unknown.length > 0) {
    console.error("Unknown:");
    for (const name of selection.unknown) console.error(`  - ${name}`);
  }
  if (selection.ambiguous.length > 0) {
    console.error("Ambiguous:");
    for (const entry of selection.ambiguous) {
      console.error(`  - ${entry.target}: ${entry.matches.join(", ")}`);
    }
  }
  console.error(`\nAvailable contracts: ${listContractNames(allContracts)}`);
  process.exit(1);
}

const contracts = selection.contracts;
const mock = allContracts.find((c) => c.isMockHub);
if (!mock) {
  console.error("❌ Error: mock-game-hub contract not found in workspace members");
  process.exit(1);
}

const needsMock = contracts.some((c) => !c.isMockHub);
const deployMockRequested = contracts.some((c) => c.isMockHub);
const shouldEnsureMock = deployMockRequested || needsMock;

// Check required WASM files exist for selected contracts (non-mock first)
const missingWasm: string[] = [];
for (const contract of contracts) {
  if (contract.isMockHub) continue;
  if (!await Bun.file(contract.wasmPath).exists()) missingWasm.push(contract.wasmPath);
}
if (missingWasm.length > 0) {
  console.error("❌ Error: Missing WASM build outputs:");
  for (const p of missingWasm) console.error(`  - ${p}`);
  console.error("\nRun 'bun run build [contract-name]' first");
  process.exit(1);
}

// Create three testnet identities: admin, player1, player2
// Admin signs deployments directly via secret key (no CLI identity required).
// Player1 and player2 are keypairs for frontend dev use.
const walletAddresses: Record<string, string> = {};
const walletSecrets: Record<string, string> = {};

// Load existing secrets from .env if available
let existingSecrets: Record<string, string | null> = {
  player1: null,
  player2: null,
};

// Load existing deployment info so partial deploys can preserve other IDs.
const existingContractIds: Record<string, string> = {};
let existingDeployment: any = null;
if (existsSync("deployment.json")) {
  try {
    existingDeployment = await Bun.file("deployment.json").json();
    if (existingDeployment?.contracts && typeof existingDeployment.contracts === "object") {
      Object.assign(existingContractIds, existingDeployment.contracts);
    } else {
      // Backwards compatible fallback
      if (existingDeployment?.mockGameHubId) existingContractIds["mock-game-hub"] = existingDeployment.mockGameHubId;
      if (existingDeployment?.twentyOneId) existingContractIds["twenty-one"] = existingDeployment.twentyOneId;
      if (existingDeployment?.numberGuessId) existingContractIds["number-guess"] = existingDeployment.numberGuessId;
    }
  } catch (error) {
    console.warn("⚠️  Warning: Failed to parse deployment.json, continuing...");
  }
}

const existingEnv = await readEnvFile('.env');
const rawDeadDropVerifierMode = getEnvValue(existingEnv, 'DEAD_DROP_VERIFIER_MODE', 'mock').toLowerCase();
const deadDropVerifierMode = rawDeadDropVerifierMode === 'real' ? 'real' : 'mock';
const deadDropVerifierContractId = getEnvValue(
  existingEnv,
  'DEAD_DROP_VERIFIER_CONTRACT_ID',
  getEnvValue(existingEnv, 'VITE_DEAD_DROP_VERIFIER_CONTRACT_ID')
);
const deadDropRandomnessVerifierContractId = getEnvValue(
  existingEnv,
  'DEAD_DROP_RANDOMNESS_VERIFIER_CONTRACT_ID',
  getEnvValue(existingEnv, 'VITE_DEAD_DROP_RANDOMNESS_VERIFIER_CONTRACT_ID')
);
const deadDropVerifierSelectorHex = getEnvValue(
  existingEnv,
  'DEAD_DROP_VERIFIER_SELECTOR_HEX',
  getEnvValue(existingEnv, 'VITE_DEAD_DROP_VERIFIER_SELECTOR_HEX')
);
const deadDropProverUrl = getEnvValue(
  existingEnv,
  'VITE_DEAD_DROP_PROVER_URL',
  existingDeployment?.deadDrop?.proverUrl || ""
);
const deadDropRelayerUrl = getEnvValue(
  existingEnv,
  'VITE_DEAD_DROP_RELAYER_URL',
  existingDeployment?.deadDrop?.relayerUrl || ""
);
const ozRelayerApiKey = getEnvValue(existingEnv, 'OZ_RELAYER_API_KEY');
const ozRelayerBaseUrl = getEnvValue(
  existingEnv,
  'OZ_RELAYER_BASE_URL',
  'https://channels.openzeppelin.com/testnet'
);
const walletMode = getEnvValue(existingEnv, 'VITE_WALLET_MODE', existingDeployment?.wallet?.mode || 'dev');
const smartAccountWasmHash = getEnvValue(
  existingEnv,
  'VITE_SMART_ACCOUNT_WASM_HASH',
  existingDeployment?.wallet?.smartAccountWasmHash || ""
);
const smartAccountWebauthnVerifierAddress = getEnvValue(
  existingEnv,
  'VITE_SMART_ACCOUNT_WEBAUTHN_VERIFIER_ADDRESS',
  existingDeployment?.wallet?.smartAccountWebauthnVerifierAddress || ""
);
const smartAccountRpName = getEnvValue(
  existingEnv,
  'VITE_SMART_ACCOUNT_RP_NAME',
  existingDeployment?.wallet?.smartAccountRpName || "Dead Drop"
);

console.log(`Dead Drop verifier mode: ${deadDropVerifierMode}`);
if (deadDropVerifierMode === "real") {
  console.log(`Dead Drop external verifier: ${deadDropVerifierContractId || "(missing)"}`);
  console.log(`Dead Drop external randomness verifier: ${deadDropRandomnessVerifierContractId || "(default: verifier)"}`);
}

if (deadDropVerifierMode === "real" && !deadDropVerifierContractId) {
  console.error("❌ DEAD_DROP_VERIFIER_CONTRACT_ID is required when DEAD_DROP_VERIFIER_MODE=real.");
  process.exit(1);
}
for (const identity of ['player1', 'player2']) {
  const key = `VITE_DEV_${identity.toUpperCase()}_SECRET`;
  const v = getEnvValue(existingEnv, key);
  if (v && v !== 'NOT_AVAILABLE') existingSecrets[identity] = v;
}

for (const contract of allContracts) {
  if (existingContractIds[contract.packageName]) continue;
  const envId = getEnvValue(existingEnv, `VITE_${contract.envKey}_CONTRACT_ID`);
  if (envId) existingContractIds[contract.packageName] = envId;
}

// Handle admin identity (needs to be in Stellar CLI for deployment)
console.log('Setting up admin identity...');
console.log('📝 Generating new admin identity...');
const adminKeypair = Keypair.random();

walletAddresses.admin = adminKeypair.publicKey();

try {
  await ensureTestnetFunded(walletAddresses.admin);
  console.log('✅ admin funded');
} catch (error) {
  const details = error instanceof Error ? error.message : String(error);
  console.error(`❌ Failed to ensure admin is funded. Deployment cannot proceed.\n   ${details}`);
  process.exit(1);
}

// Handle player identities (don't need to be in CLI, just keypairs)
for (const identity of ['player1', 'player2']) {
  console.log(`Setting up ${identity}...`);

  let keypair: Keypair;
  if (existingSecrets[identity]) {
    console.log(`✅ Using existing ${identity} from .env`);
    keypair = Keypair.fromSecret(existingSecrets[identity]!);
  } else {
    console.log(`📝 Generating new ${identity}...`);
    keypair = Keypair.random();
  }

  walletAddresses[identity] = keypair.publicKey();
  walletSecrets[identity] = keypair.secret();
  console.log(`✅ ${identity}: ${keypair.publicKey()}`);

  // Ensure player accounts exist on testnet (even if reusing keys from .env)
  try {
    await ensureTestnetFunded(keypair.publicKey());
    console.log(`✅ ${identity} funded\n`);
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    console.warn(`⚠️  Warning: Failed to ensure ${identity} is funded, continuing anyway...\n   ${details}`);
  }
}

// Save to deployment.json and .env for setup script to use
console.log("🔐 Player secret keys will be saved to .env (gitignored)\n");

console.log("💼 Wallet addresses:");
console.log(`  Admin:   ${walletAddresses.admin}`);
console.log(`  Player1: ${walletAddresses.player1}`);
console.log(`  Player2: ${walletAddresses.player2}\n`);

// Use admin secret for contract deployment
const adminAddress = walletAddresses.admin;
const adminSecret = adminKeypair.secret();

const deployed: Record<string, string> = { ...existingContractIds };

// Ensure mock Game Hub exists so we can pass it into game constructors.
let mockGameHubId = existingContractIds[mock.packageName] || "";
if (shouldEnsureMock) {
  const candidateMockIds = [
    existingContractIds[mock.packageName],
    existingDeployment?.mockGameHubId,
    EXISTING_GAME_HUB_TESTNET_CONTRACT_ID,
  ].filter(Boolean) as string[];

  for (const candidate of candidateMockIds) {
    if (await testnetContractExists(candidate)) {
      mockGameHubId = candidate;
      break;
    }
  }

  if (mockGameHubId) {
    deployed[mock.packageName] = mockGameHubId;
    console.log(`✅ Using existing ${mock.packageName} on testnet: ${mockGameHubId}\n`);
  } else {
    if (!await Bun.file(mock.wasmPath).exists()) {
      console.error("❌ Error: Missing WASM build output for mock-game-hub:");
      console.error(`  - ${mock.wasmPath}`);
      console.error("\nRun 'bun run build mock-game-hub' first");
      process.exit(1);
    }

    console.warn(`⚠️  ${mock.packageName} not found on testnet (archived or reset). Deploying a new one...`);
    console.log(`Deploying ${mock.packageName}...`);
    try {
      const result =
        await $`stellar contract deploy --wasm ${mock.wasmPath} --source-account ${adminSecret} --network ${NETWORK}`.text();
      mockGameHubId = result.trim();
      deployed[mock.packageName] = mockGameHubId;
      console.log(`✅ ${mock.packageName} deployed: ${mockGameHubId}\n`);
    } catch (error) {
      console.error(`❌ Failed to deploy ${mock.packageName}:`, error);
      process.exit(1);
    }
  }
}

// Deploy mock-verifier first if requested (no constructor args)
const mockVerifierContract = contracts.find((c) => c.packageName === "mock-verifier");
let mockVerifierId = deployed["mock-verifier"] || "";
if (mockVerifierContract && deadDropVerifierMode !== "real") {
  console.log(`Deploying ${mockVerifierContract.packageName}...`);
  try {
    console.log("  Installing WASM...");
    const installResult =
      await $`stellar contract install --wasm ${mockVerifierContract.wasmPath} --source-account ${adminSecret} --network ${NETWORK}`.text();
    const wasmHash = installResult.trim();
    console.log(`  WASM hash: ${wasmHash}`);

    console.log("  Deploying (no constructor)...");
    const deployResult =
      await $`stellar contract deploy --wasm-hash ${wasmHash} --source-account ${adminSecret} --network ${NETWORK}`.text();
    const contractId = deployResult.trim();
    deployed[mockVerifierContract.packageName] = contractId;
    mockVerifierId = contractId;
    console.log(`✅ ${mockVerifierContract.packageName} deployed: ${contractId}\n`);
  } catch (error) {
    console.error(`❌ Failed to deploy ${mockVerifierContract.packageName}:`, error);
    process.exit(1);
  }
}

// Deploy remaining contracts
for (const contract of contracts) {
  if (contract.isMockHub) continue;
  if (contract.packageName === "mock-verifier") continue; // already deployed above

  console.log(`Deploying ${contract.packageName}...`);
  try {
    console.log("  Installing WASM...");
    const installResult =
      await $`stellar contract install --wasm ${contract.wasmPath} --source-account ${adminSecret} --network ${NETWORK}`.text();
    const wasmHash = installResult.trim();
    console.log(`  WASM hash: ${wasmHash}`);

    console.log("  Deploying and initializing...");
    let deployResult: string;

    if (contract.packageName === "dead-drop") {
      // dead-drop needs verifier_id and ping_image_id in addition to admin + game_hub
      const verifierId = deadDropVerifierMode === "real"
        ? deadDropVerifierContractId
        : (mockVerifierId || existingContractIds["mock-verifier"] || "");
      if (!verifierId) {
        console.error("❌ dead-drop verifier contract ID is required. Set DEAD_DROP_VERIFIER_CONTRACT_ID for real mode or deploy mock-verifier for mock mode.");
        process.exit(1);
      }
      const randomnessVerifierId = deadDropRandomnessVerifierContractId || verifierId;
      deployResult =
        (await $`stellar contract deploy --wasm-hash ${wasmHash} --source-account ${adminSecret} --network ${NETWORK} -- --admin ${adminAddress} --game-hub ${mockGameHubId} --verifier-id ${verifierId} --randomness-verifier-id ${randomnessVerifierId}`.text());
    } else {
      deployResult =
        (await $`stellar contract deploy --wasm-hash ${wasmHash} --source-account ${adminSecret} --network ${NETWORK} -- --admin ${adminAddress} --game-hub ${mockGameHubId}`.text());
    }

    const contractId = deployResult.trim();
    deployed[contract.packageName] = contractId;
    console.log(`✅ ${contract.packageName} deployed: ${contractId}\n`);
  } catch (error) {
    console.error(`❌ Failed to deploy ${contract.packageName}:`, error);
    process.exit(1);
  }
}

console.log("🎉 Deployment complete!\n");
console.log("Contract IDs:");
const outputContracts = new Set<string>();
for (const contract of contracts) outputContracts.add(contract.packageName);
if (shouldEnsureMock) outputContracts.add(mock.packageName);
for (const contract of allContracts) {
  if (!outputContracts.has(contract.packageName)) continue;
  const id = deployed[contract.packageName];
  if (id) console.log(`  ${contract.packageName}: ${id}`);
}

const twentyOneId = deployed["twenty-one"] || "";
const numberGuessId = deployed["number-guess"] || "";

const deploymentContracts = allContracts.reduce<Record<string, string>>((acc, contract) => {
  acc[contract.packageName] = deployed[contract.packageName] || "";
  return acc;
}, {});

const deploymentInfo = {
  mockGameHubId,
  twentyOneId,
  numberGuessId,
  contracts: deploymentContracts,
  network: NETWORK,
  rpcUrl: RPC_URL,
  networkPassphrase: NETWORK_PASSPHRASE,
  wallets: {
    admin: walletAddresses.admin,
    player1: walletAddresses.player1,
    player2: walletAddresses.player2,
  },
  deadDrop: {
    verifierMode: deadDropVerifierMode,
    verifierContractId: deadDropVerifierMode === "real"
      ? deadDropVerifierContractId
      : (mockVerifierId || existingContractIds["mock-verifier"] || ""),
    randomnessVerifierContractId: deadDropRandomnessVerifierContractId || (
      deadDropVerifierMode === "real"
        ? deadDropVerifierContractId
        : (mockVerifierId || existingContractIds["mock-verifier"] || "")
    ),
    verifierSelectorHex: deadDropVerifierSelectorHex,
    proverUrl: deadDropProverUrl,
    relayerUrl: deadDropRelayerUrl,
  },
  wallet: {
    mode: walletMode,
    smartAccountWasmHash,
    smartAccountWebauthnVerifierAddress,
    smartAccountRpName,
  },
  deployedAt: new Date().toISOString(),
};

await Bun.write('deployment.json', JSON.stringify(deploymentInfo, null, 2) + '\n');
console.log("\n✅ Wrote deployment info to deployment.json");

const contractEnvLines = allContracts
  .map((c) => `VITE_${c.envKey}_CONTRACT_ID=${deploymentContracts[c.packageName] || ""}`)
  .join("\n");

const envContent = `# Auto-generated by deploy script
# Do not edit manually - run 'bun run deploy' (or 'bun run setup') to regenerate
# WARNING: This file contains secret keys. Never commit to git!

VITE_SOROBAN_RPC_URL=${RPC_URL}
VITE_NETWORK_PASSPHRASE=${NETWORK_PASSPHRASE}
${contractEnvLines}
VITE_DEAD_DROP_PROVER_URL=${deadDropProverUrl}
VITE_DEAD_DROP_RELAYER_URL=${deadDropRelayerUrl}
VITE_DEAD_DROP_VERIFIER_CONTRACT_ID=${deploymentInfo.deadDrop.verifierContractId}
VITE_DEAD_DROP_RANDOMNESS_VERIFIER_CONTRACT_ID=${deploymentInfo.deadDrop.randomnessVerifierContractId}
VITE_DEAD_DROP_VERIFIER_SELECTOR_HEX=${deadDropVerifierSelectorHex}
VITE_WALLET_MODE=${walletMode}
VITE_SMART_ACCOUNT_WASM_HASH=${smartAccountWasmHash}
VITE_SMART_ACCOUNT_WEBAUTHN_VERIFIER_ADDRESS=${smartAccountWebauthnVerifierAddress}
VITE_SMART_ACCOUNT_RP_NAME=${smartAccountRpName}

# Dev wallet addresses for testing
VITE_DEV_ADMIN_ADDRESS=${walletAddresses.admin}
VITE_DEV_PLAYER1_ADDRESS=${walletAddresses.player1}
VITE_DEV_PLAYER2_ADDRESS=${walletAddresses.player2}

# Dev wallet secret keys (WARNING: Never commit this file!)
VITE_DEV_PLAYER1_SECRET=${walletSecrets.player1}
VITE_DEV_PLAYER2_SECRET=${walletSecrets.player2}

# Dead Drop verifier/prover mode
DEAD_DROP_VERIFIER_MODE=${deadDropVerifierMode}
DEAD_DROP_VERIFIER_CONTRACT_ID=${deploymentInfo.deadDrop.verifierContractId}
DEAD_DROP_RANDOMNESS_VERIFIER_CONTRACT_ID=${deploymentInfo.deadDrop.randomnessVerifierContractId}
DEAD_DROP_VERIFIER_SELECTOR_HEX=${deadDropVerifierSelectorHex}
OZ_RELAYER_API_KEY=${ozRelayerApiKey}
OZ_RELAYER_BASE_URL=${ozRelayerBaseUrl}
`;

await Bun.write('.env', envContent + '\n');
console.log("✅ Wrote secrets to .env (gitignored)");

export { mockGameHubId, deployed };
