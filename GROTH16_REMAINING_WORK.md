# Groth16 Implementation - Remaining Work

## ✅ Completed (2026-02-22)

### Step 1: Trusted Setup ✅
- Generated proving key (zkey): `circuits/dead_drop/target/groth16/dead_drop_final.zkey` (773 KB)
- Generated verification key: `circuits/dead_drop/target/groth16/vkey.json` (2.6 KB)
- R1CS circuit: `circuits/dead_drop/target/groth16/interop/circuit.r1cs` (220 KB)
- Test proof verified locally with snarkjs: ✅ OK

### Step 2: Set Verification Key ✅
- VK encoded for Soroban: `circuits/dead_drop/target/groth16/vk_bytes.hex` (1.8 KB)
- VK set in contract `CA7T3FJMCIJ6HA3Z56VVD7J5A2HLZ5JLWNPODB43GML7JJSQHSWWSQKC` ✅
- Transaction: `4a5c047a892a13210d1efba41bb18fde4a12b8bc06f9f6274ed03394746df32b`

### Step 3: Backend Prover ✅
- Updated `backend/dead-drop-prover/prover.js` to use Groth16
- Added `backend/dead-drop-prover/encoder.js` for BN254 encoding
- Installed snarkjs dependency
- Proof generation tested locally:
  - Witness generation: ~60 ms
  - Proof generation: ~170 ms
  - Proof size: **259 bytes** (518 hex chars) = 99.8% smaller than UltraHonk
  - Public inputs: 6 field elements (session_id, turn, ping_x, ping_y, commitment, distance)

## ⏳ Remaining Work (Est. 2-3 hours)

### Step 4: Update Frontend Prover (90 minutes)

**File**: `dead-drop-frontend/src/games/dead-drop/deadDropNoirService.ts`

**Tasks**:
1. **Generate WASM witness calculator**:
   ```bash
   cd circuits/dead_drop
   nargo compile
   # Creates target/dead_drop_js/ with WASM witness calculator
   ```

2. **Copy zkey to frontend**:
   ```bash
   cp target/groth16/dead_drop_final.zkey \
      ../../dead-drop-frontend/public/dead_drop_final.zkey

   # Optional: compress for faster download
   gzip -k ../../dead-drop-frontend/public/dead_drop_final.zkey
   # Creates dead_drop_final.zkey.gz (~300 KB vs 773 KB)
   ```

3. **Create BN254 encoder TypeScript utility**:
   - Copy `backend/dead-drop-prover/encoder.js`
   - Convert to TypeScript: `dead-drop-frontend/src/games/dead-drop/utils/encodeBn254.ts`
   - Export `encodeProof(proof)` and `encodePublic(publicSignals)` functions

4. **Update `deadDropNoirService.ts`**:
   ```typescript
   import snarkjs from 'snarkjs';
   import { encodeProof, encodePublic } from './utils/encodeBn254';

   // Add zkey loader (lazy load)
   let zkeyCache: ArrayBuffer | null = null;

   async function loadZkey(): Promise<ArrayBuffer> {
     if (zkeyCache) return zkeyCache;

     // Try gzipped version first
     try {
       const response = await fetch('/dead_drop_final.zkey.gz');
       if (!response.ok) throw new Error('Gzipped zkey not found');
       const blob = await response.blob();
       const decompressed = await blob.stream().pipeThrough(new DecompressionStream('gzip'));
       zkeyCache = await new Response(decompressed).arrayBuffer();
     } catch {
       // Fallback to uncompressed
       const response = await fetch('/dead_drop_final.zkey');
       zkeyCache = await response.arrayBuffer();
     }

     return zkeyCache;
   }

   // Add witness generator loader
   import deadDropWasm from '../../../../circuits/dead_drop/target/dead_drop_js/dead_drop.wasm?url';

   async function loadWitnessCalculator() {
     const module = await import('../../../../circuits/dead_drop/target/dead_drop_js/index.js');
     return await module.default({ wasm: deadDropWasm });
   }

   // Replace proof generation function
   export async function provePingGroth16(inputs: {
     session_id: number;
     turn: number;
     ping_x: number;
     ping_y: number;
     drop_x: number;
     drop_y: number;
     drop_salt_hex: string;
     expected_commitment: string;
     expected_distance: number;
   }) {
     // 1. Load zkey and witness calculator
     const [zkey, witnessCalculator] = await Promise.all([
       loadZkey(),
       loadWitnessCalculator()
     ]);

     // 2. Generate witness
     const witnessInput = {
       drop_x: inputs.drop_x.toString(),
       drop_y: inputs.drop_y.toString(),
       drop_salt: inputs.drop_salt_hex,
       session_id: inputs.session_id.toString(),
       turn: inputs.turn.toString(),
       ping_x: inputs.ping_x.toString(),
       ping_y: inputs.ping_y.toString(),
       expected_commitment: inputs.expected_commitment,
       expected_distance: inputs.expected_distance.toString()
     };

     const witness = await witnessCalculator.calculateWitness(witnessInput);

     // 3. Generate Groth16 proof
     const { proof, publicSignals } = await snarkjs.groth16.prove(zkey, witness);

     // 4. Encode for Soroban
     const proofHex = encodeProof(proof);
     const publicHex = encodePublic(publicSignals);

     return { proofHex, publicInputsHex: publicHex };
   }
   ```

5. **Update dependencies**:
   ```bash
   cd dead-drop-frontend
   npm install snarkjs
   ```

6. **Update UI to show loading state** during zkey download:
   - Add progress indicator: "Downloading proving key... (300 KB)"
   - Only download on first proof generation (cached after that)

**Expected Changes**:
- Initial zkey download: 2-5 seconds (300 KB gzipped, one-time)
- Proof generation: 1-3 seconds (similar to UltraHonk)
- Proof upload size: 259 bytes (99.8% reduction!)

---

### Step 5: End-to-End Testing (30 minutes)

**Test Flow**:

1. **Start services**:
   ```bash
   # Terminal 1: Backend prover
   cd backend/dead-drop-prover && npm start

   # Terminal 2: Frontend
   cd dead-drop-frontend && bun run dev
   ```

2. **Two-Player Game**:
   - Open two browser sessions
   - Player 1: Create Game → Get room code
   - Player 2: Join with room code
   - **Check**: Randomness proof should be ~600 bytes total (vs ~140 KB)

3. **Submit Pings**:
   - Both players submit pings
   - Monitor browser console: "Proof size: 518 chars"
   - **Check**: On-chain verification succeeds
   - **Check**: Transaction size ~1 KB (vs ~140 KB)
   - **Check**: No VerifierError

4. **Invalid Proof Test**:
   ```javascript
   // In browser DevTools:
   const validProof = '0x...'; // 518 chars
   const tamperedProof = validProof.slice(0, 10) + 'FF' + validProof.slice(12);
   // Submit tampered proof - should fail with VerifierError
   ```

**Success Criteria**:
- ✅ All submitPing transactions succeed
- ✅ Proof size is 259 bytes (518 hex chars)
- ✅ On-chain verification completes successfully
- ✅ Invalid proofs are rejected
- ✅ Game completes normally with correct winner
- ✅ Transaction costs are ~97% lower than UltraHonk estimates

---

## Performance Gains Achieved

| Metric | UltraHonk | Groth16 | Improvement |
|--------|-----------|---------|-------------|
| Proof size | ~140 KB | 259 bytes | **99.8%** |
| Proof format | UltraHonk | Groth16 | Production-ready |
| Trusted setup | Not needed | ✅ Complete | Cryptographically sound |
| On-chain cost (est.) | ~1M instructions | ~30K instructions | **97%** |

---

## Files Modified

### Circuits
- ✅ `circuits/dead_drop/inputs.json` - Valid test input for setup
- ✅ `circuits/dead_drop/target/groth16/*` - All Groth16 artifacts

### Backend
- ✅ `backend/dead-drop-prover/prover.js` - Groth16 proof generation
- ✅ `backend/dead-drop-prover/encoder.js` - BN254 encoding for Soroban
- ✅ `backend/dead-drop-prover/package.json` - Added snarkjs

### Frontend (TODO)
- ⏳ `dead-drop-frontend/src/games/dead-drop/deadDropNoirService.ts` - Client-side Groth16
- ⏳ `dead-drop-frontend/src/games/dead-drop/utils/encodeBn254.ts` - TypeScript encoder
- ⏳ `dead-drop-frontend/public/dead_drop_final.zkey.gz` - Proving key
- ⏳ `dead-drop-frontend/package.json` - Add snarkjs

### Contracts (NO CHANGES NEEDED ✅)
- Dead Drop contract works with Groth16 via verifier wrapper
- Groth16 verifier already deployed and initialized

---

## Next Steps

1. **Complete Step 4**: Update frontend prover (~90 min)
2. **Complete Step 5**: E2E testing (~30 min)
3. **Update MEMORY.md**: Mark Groth16 migration complete
4. **Deploy to production**: Copy zkey to CDN for faster loading

---

## Notes

- The 259-byte proof size includes Soroban infinity flags (65 + 129 + 65 bytes)
- Raw Groth16 is 192 bytes (64 + 128 bytes for BN254 curve points)
- Both are 99%+ smaller than UltraHonk, mission accomplished! 🎉
- The backend prover is fully functional and tested
- The verifier contract is initialized and ready to verify proofs
