#!/usr/bin/env bash
set -e

# Dead Drop Groth16 Trusted Setup Script
# Generates zkey and verification key for the Dead Drop circuit

CIRCUIT_DIR="/Users/wlademyr/Code/hackathon-zk-wlad/circuits/dead_drop"
NOIR_CLI="/Users/wlademyr/Code/hackathon-zk-wlad/noir-groth16-reference/target/release/noir-cli"
PTAU_FILE="/Users/wlademyr/Code/hackathon-zk-wlad/noir-groth16-reference/target/groth16/pot12_final.ptau"
OUT_DIR="$CIRCUIT_DIR/target/groth16"

mkdir -p "$OUT_DIR"

echo "[1/6] Compiling Noir circuit..."
cd "$CIRCUIT_DIR"
nargo compile

echo "[2/6] Generating test witness and R1CS..."
# Create a minimal valid input (must satisfy constraints so noir-cli emits witness + R1CS)
TEST_DROP_X=50
TEST_DROP_Y=50
TEST_DROP_SALT="0x0000000000000000000000000000000000000000000000000000000000000001"
TEST_COMMITMENT=$(cd "/Users/wlademyr/Code/hackathon-zk-wlad" && node -e "const { computeDropCommitment } = require('./backend/dead-drop-prover/prover'); process.stdout.write('0x' + computeDropCommitment($TEST_DROP_X, $TEST_DROP_Y, '$TEST_DROP_SALT'));")
cat > "$OUT_DIR/test_input.json" << 'EOF'
{
  "drop_x": "__TEST_DROP_X__",
  "drop_y": "__TEST_DROP_Y__",
  "drop_salt": "__TEST_DROP_SALT__",
  "session_id": "1",
  "turn": "1",
  "ping_x": "50",
  "ping_y": "50",
  "expected_commitment": "__TEST_COMMITMENT__",
  "expected_distance": "0"
}
EOF
sed -i.bak \
  -e "s/__TEST_DROP_X__/$TEST_DROP_X/g" \
  -e "s/__TEST_DROP_Y__/$TEST_DROP_Y/g" \
  -e "s#__TEST_DROP_SALT__#$TEST_DROP_SALT#g" \
  -e "s#__TEST_COMMITMENT__#$TEST_COMMITMENT#g" \
  "$OUT_DIR/test_input.json"
rm -f "$OUT_DIR/test_input.json.bak"

# Generate witness (using --no-pedantic to skip strict validation for setup purposes)
$NOIR_CLI interop \
  target/dead_drop.json \
  "$OUT_DIR/test_input.json" \
  --out "$OUT_DIR/interop" \
  --no-pedantic || {
    echo "⚠️  Witness generation failed - computing correct commitment..."
    # Use nargo to compute the correct commitment
    cat > Prover.toml << 'EOF'
drop_x = "50"
drop_y = "50"
drop_salt = "0x0000000000000000000000000000000000000000000000000000000000000001"
session_id = "1"
turn = "1"
ping_x = "50"
ping_y = "50"
expected_commitment = "0x0"
expected_distance = "0"
EOF
    nargo execute witness 2>&1 | grep -A5 "Failed constraint" || true
    echo "⚠️  Skipping witness validation for trusted setup (not needed for zkey generation)"
    echo "    The Powers of Tau ceremony only requires the R1CS circuit structure."
}

if [ ! -f "$OUT_DIR/interop/circuit.r1cs" ]; then
  echo "❌ R1CS generation failed. Cannot proceed with trusted setup."
  exit 1
fi

echo "[3/6] Circuit info:"
$NOIR_CLI compile-r1cs target/dead_drop.json --out "$OUT_DIR/parse" 2>&1 | tail -5

echo "[4/6] Running Groth16 setup with Powers of Tau..."
snarkjs groth16 setup \
  "$OUT_DIR/interop/circuit.r1cs" \
  "$PTAU_FILE" \
  "$OUT_DIR/dead_drop_0000.zkey"

echo "[5/6] Contributing to zkey (adds randomness)..."
snarkjs zkey contribute \
  "$OUT_DIR/dead_drop_0000.zkey" \
  "$OUT_DIR/dead_drop_final.zkey" \
  --name="Dead Drop Groth16 v1" \
  --entropy="$(date +%s)$(openssl rand -hex 32)"

echo "[6/7] Exporting verification key..."
snarkjs zkey export verificationkey \
  "$OUT_DIR/dead_drop_final.zkey" \
  "$OUT_DIR/vkey.json"

echo "[7/7] Verifying prover artifact public-input layout..."
(
  cd "/Users/wlademyr/Code/hackathon-zk-wlad"
  node -e 'require("./backend/dead-drop-prover/prover").selfCheckProverArtifacts().catch((err)=>{console.error(err?.stack||err?.message||err);process.exit(1);})'
)

echo ""
echo "✅ Groth16 trusted setup complete!"
echo ""
echo "📁 Artifacts:"
echo "   Powers of Tau: $PTAU_FILE"
echo "   R1CS circuit:  $OUT_DIR/interop/circuit.r1cs"
echo "   Proving key:   $OUT_DIR/dead_drop_final.zkey"
echo "   Verifying key: $OUT_DIR/vkey.json"
echo ""
echo "📊 File sizes:"
ls -lh "$OUT_DIR/dead_drop_final.zkey" "$OUT_DIR/vkey.json"
echo ""
echo "Next steps:"
echo "  1. Encode VK for Soroban: node encode_bn254_for_soroban.mjs encode-vk $OUT_DIR/vkey.json $OUT_DIR/vk_bytes.hex"
echo "  2. Set VK in verifier: stellar contract invoke --id <verifier> -- set_vk --vk-bytes \$(cat $OUT_DIR/vk_bytes.hex)"
echo "  3. Copy zkey to: circuits/dead_drop/target/dead_drop_final.zkey"
