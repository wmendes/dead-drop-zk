# DEAD DROP: A Trustless Zero-Knowledge Scavenger Hunt on Stellar

### The "Nuclear Keys" Protocol for Serverless P2P Gaming

**Version:** 2.0 (Hackathon Implementation Spec)
**Chain:** Stellar Soroban (Protocol 25)
**ZK Stack:** RiscZero zkVM → Groth16 → Nethermind Verifier
**Reference Implementation:** TypeZero (jamesbachini/typezero)

---

## 1. Executive Summary

**Dead Drop** is a 1v1 strategy game where two players (Agents) compete to find a hidden package (The Drop) on a discrete grid map.

The game solves the fundamental "God View" paradox of serverless blockchain games: *who hides the treasure when there's no trusted server?* Dead Drop uses **Distributed Secret Sharing** — the coordinates of the Drop are split mathematically between the two players. Neither player knows the location, but by combining their encrypted data via Zero-Knowledge proofs, they can calculate their distance to the target without revealing it.

**What makes this buildable now:** The Nethermind Groth16 verifier contract, deployed on Stellar Testnet in September 2025, enables on-chain verification of RiscZero zkVM proofs. This is the same proven pipeline used by TypeZero (a ZK-verified typing game on Stellar). Dead Drop adapts this infrastructure for a fundamentally different — and more ambitious — use case: trustless hidden information in a two-player adversarial game.

---

## 2. The Problem: Hidden Information Without Trust

### The "God View" Paradox

In any treasure-hunt game, someone must hide the treasure. On a public blockchain, this creates a paradox:

- If the **Smart Contract** generates the coordinate, it's stored on the public ledger. Anyone can read the storage slot and find the treasure instantly.
- If **Player A** hides it, Player A knows where it is — giving them an unfair advantage.
- If a **Server** hides it, the game depends on a trusted third party — defeating the purpose of building on-chain.

### The Solution: The "Nuclear Keys" Mechanic

We use a **2-of-2 Additive Secret Sharing Scheme**:

```
Drop Location: S = Sa + Sb  (mod GRID_SIZE)
```

- **Player A** generates random secret coordinate `Sa = (Xa, Ya)`. Commits `H(Sa)` on-chain.
- **Player B** generates random secret coordinate `Sb = (Xb, Yb)`. Commits `H(Sb)` on-chain.
- **The Drop** exists at `S = ((Xa+Xb) mod N, (Ya+Yb) mod N)`, but neither player can compute this because they lack the other's secret.

When Player A guesses a location, they cryptographically ask Player B: *"How far is my guess from the Drop?"* Player B's system computes the answer and generates a ZK proof that the distance was computed honestly — without revealing `Sb`.

---

## 3. Architecture Overview

### 3.1 System Architecture

```
┌─────────────────┐                    ┌─────────────────┐
│   Agent A        │◄──── WebRTC ─────►│   Agent B        │
│   (Browser)      │                    │   (Browser)      │
└────────┬─────────┘                    └────────┬─────────┘
         │                                       │
         │ Submits game actions                  │ Submits game actions
         │ + ZK proof artifacts                  │ + ZK proof artifacts
         ▼                                       ▼
┌──────────────────────────────────────────────────────────┐
│                    Proving Service                         │
│              (Stateless RiscZero Host)                     │
│                                                            │
│  Receives private inputs → Generates STARK → Groth16 wrap │
│  Returns: seal + journal_hash + image_id                   │
│                                                            │
│  CANNOT cheat: proof binds to inputs deterministically     │
└────────────────────────┬─────────────────────────────────┘
                         │
                         │ Proof artifacts submitted
                         │ via player's signed transaction
                         ▼
┌──────────────────────────────────────────────────────────┐
│                  Stellar Soroban                          │
│                                                            │
│  ┌─────────────────────┐  ┌─────────────────────────┐    │
│  │  Dead Drop Contract  │  │  Nethermind Groth16      │    │
│  │                       │  │  Verifier Contract       │    │
│  │  - Game state         │──│                           │    │
│  │  - Escrow (XLM)       │  │  (Already deployed on    │    │
│  │  - Commitments        │  │   Stellar Testnet)       │    │
│  │  - Turn management    │  │                           │    │
│  │  - Timeout slashing   │  └─────────────────────────┘    │
│  └─────────────────────┘                                   │
└──────────────────────────────────────────────────────────┘
```

### 3.2 Technology Stack

| Layer | Technology | Role |
|-------|-----------|------|
| Smart Contracts | Soroban SDK 25.0.2 (Rust/WASM) | Game state, escrow, proof verification dispatch |
| ZK Proving | RiscZero zkVM | Guest programs for distance computation & gadget validation |
| Proof Format | Groth16 (via RiscZero STARK→SNARK recursion) | Compact proofs verifiable on-chain |
| On-Chain Verifier | Nethermind Groth16 Verifier Contract | Deployed on Stellar Testnet — reuse directly |
| P2P Communication | WebRTC (primary) / Stellar Events (fallback) | Real-time ping exchange between players |
| Frontend | Vanilla JS + Stellar SDK (browser build) | Game UI, wallet integration, auto-responder |
| Backend | Node.js + RiscZero Host binary | Stateless proof generation service |

### 3.3 What We Inherit From TypeZero

TypeZero (github.com/jamesbachini/typezero) provides a complete, working reference for the RiscZero → Groth16 → Soroban pipeline. Dead Drop inherits:

1. **Proof artifact format**: `seal` (Groth16 proof bytes), `journal_hash` (SHA-256 of public outputs), `image_id` (deterministic program hash)
2. **Verifier integration pattern**: The Soroban contract calls the Nethermind Groth16 verifier via cross-contract invocation, passing the `VERIFIER_SELECTOR_HEX` prefix
3. **Backend proving service architecture**: Node.js HTTP server that shells out to the RiscZero host binary, returns proof artifacts to the frontend
4. **Frontend → chain submission flow**: Browser receives proof artifacts, constructs and signs a Soroban transaction, submits via RPC
5. **Image ID binding**: The contract stores a fixed `image_id` at initialization, ensuring only proofs from the correct guest program are accepted

What we **replace**: TypeZero's guest program (typing replay validation) is swapped for Dead Drop's guest programs (distance computation and gadget validation). The surrounding infrastructure stays the same.

---

## 4. Game Mechanics

### 4.1 The Setup (The Handshake)

**Duration:** ~30 seconds

1. **Match Creation:** Agent A calls `create_game()`, staking 100 XLM into the Dead Drop Contract.
2. **Match Join:** Agent B calls `join_game(game_id)`, staking 100 XLM.
3. **Secret Generation:**
   - Agent A generates random `Sa = (Xa, Ya)` where `0 ≤ Xa, Ya < 100` (100×100 grid).
   - Agent A computes `commitment_a = SHA256(Xa || Ya || salt_a)` and submits via `commit_secret(game_id, commitment_a)`.
   - Agent B does the same: generates `Sb`, computes `commitment_b`, submits.
4. **The Drop** now exists at `((Xa+Xb) mod 100, (Ya+Yb) mod 100)` — but neither player can compute this.

**On-chain state after setup:**
```
Game {
    game_id: u32,
    agent_a: Address,
    agent_b: Address,
    commitment_a: BytesN<32>,
    commitment_b: BytesN<32>,
    stake_per_player: i128,     // 100 XLM in stroops
    turn: u32,                   // starts at 0
    current_player: Address,     // alternates
    status: GameStatus,          // Setup | Active | Completed | Timeout
    last_action_ledger: u32,     // for timeout enforcement
    pings: Vec<PingRecord>,      // verified distance results
}
```

### 4.2 The Hunt (The Blind Ping)

This is the core gameplay loop. Players alternate turns making **Blind Pings**.

**Agent A's Turn:**

1. A selects a guess coordinate `G = (Gx, Gy)` on the 100×100 grid.
2. A computes their **partial offset**: `Da = (Gx - Xa, Gy - Ya)` — this reveals nothing about `Sa` to B because B doesn't know `G`.
3. A sends `Da` to B via WebRTC (encrypted channel).

**Privacy invariant:** `Da` is a transport artifact, not a renderable map coordinate. During active play, opponent ping coordinates must be treated as unknown and never displayed as exact points.

**Agent B's Auto-Response:**

4. B's client receives `Da` and automatically computes:
   ```
   Drop_relative_x = Da.x + Xb = (Gx - Xa) + Xb = Gx - (Xa - Xb)
   Drop_relative_y = Da.y + Yb = (Gy - Ya) + Yb = Gy - (Ya - Yb)

   // But actually, the distance from G to Drop is:
   // |Gx - (Xa+Xb)| + |Gy - (Ya+Yb)| = |(-Da.x - Xb) + Gx ... |
   // Simplification with modular arithmetic:
   distance = |Da.x + Xb| + |Da.y + Yb|  (Manhattan distance, mod-aware)
   ```

5. B's client sends `(Da, Sb)` as **private inputs** to the Proving Service.
6. The RiscZero guest program:
   - Verifies `SHA256(Xb || Yb || salt_b) == commitment_b` (B's on-chain commitment)
   - Computes `distance = manhattan(Da + Sb)` with grid wrapping
   - Commits public outputs: `(game_id, turn_number, distance, commitment_b_hash)`
7. The Proving Service returns Groth16 artifacts: `seal`, `journal_hash`, `image_id`
8. B submits the proof on-chain via `submit_ping(game_id, turn, distance, journal_hash, image_id, seal)`

**Contract verification:**
- Calls Nethermind Groth16 verifier with the seal
- Checks `image_id` matches the registered Dead Drop guest program
- Checks `commitment_b` in the journal matches B's on-chain commitment
- Records the verified distance and advances the turn counter

**Agent A sees the result:** `distance = 15` → "WARM (15 grid steps away)"
Only this verified distance/zone feedback is revealed; opponent exact ping coordinates remain hidden.

**Temperature Zones:**
| Distance | Zone | UI Feedback |
|----------|------|-------------|
| 0 | FOUND | Agent wins! |
| 1-5 | HOT | Red pulse + alarm |
| 6-15 | WARM | Orange glow |
| 16-30 | COOL | Blue tint |
| 31+ | COLD | Gray static |

### 4.3 Winning the Game

When a player receives `distance = 0`, they've found the Drop. The contract transitions to the claim phase:

1. Both players reveal their secrets: `reveal_secret(game_id, Sa/Sb, salt)`
2. Contract verifies `SHA256(S || salt) == commitment` for both
3. Contract replays the final ping to confirm `distance = 0`
4. Winner receives both stakes (200 XLM)

### 4.4 Turn Budget & Game Duration

Each player gets **15 turns** (30 total). If neither player finds the Drop within the budget:

1. Both reveal secrets
2. Contract computes each player's closest ping
3. Player with the smallest verified minimum distance wins
4. If tied: stakes are returned (draw)

### 4.5 The Gadgets (Shared Entropy)

To add strategic depth, each match generates 3 random gadgets per player.

**Gadget Seed:** `seed = SHA256(commitment_a || commitment_b)` — deterministic but unknown until both commit.

**Derivation:**
```rust
gadget_ids_a = [seed[0] % 5, seed[1] % 5, seed[2] % 5]
gadget_ids_b = [seed[3] % 5, seed[4] % 5, seed[5] % 5]
```

**Available Gadgets:**

| ID | Name | Effect |
|----|------|--------|
| 0 | **Sat-Link** | Peek: reveals if the Drop is in a specific 25×25 quadrant (yes/no) |
| 1 | **Double Ping** | Two guesses in one turn |
| 2 | **Smoke Screen** | Opponent's next distance result is offset by ±5 (random) |
| 3 | **Intercept** | Learn opponent's last distance result |
| 4 | **Dead Reckoning** | Reveals the axis (X or Y) of your closest ping so far |

**Gadget Validation:** When a player uses a gadget, they submit a ZK proof (via the Gadget Guest Program) proving:
- They possess valid secret shares that produce the seed
- The gadget ID they're using was legitimately derived from that seed
- The gadget hasn't been used before (checked via `gadget_usage_mask` on-chain)

---

## 5. ZK Guest Programs (RiscZero)

### 5.1 Ping Guest Program

This is the core proof. Written in Rust, compiled to RiscZero's RISC-V target.

```rust
// risc0/dead_drop/methods/guest/src/bin/ping.rs
#![no_main]
risc0_zkvm::guest::entry!(main);

use risc0_zkvm::guest::env;
use sha2::{Sha256, Digest};

fn main() {
    // === PRIVATE INPUTS (only the prover sees these) ===
    let secret_x: i32 = env::read();        // Responder's Xb
    let secret_y: i32 = env::read();        // Responder's Yb
    let salt: [u8; 32] = env::read();       // Responder's salt
    let partial_dx: i32 = env::read();      // Querier's (Gx - Xa)
    let partial_dy: i32 = env::read();      // Querier's (Gy - Ya)

    // === PUBLIC INPUTS (committed to journal, verified on-chain) ===
    let game_id: u32 = env::read();
    let turn: u32 = env::read();
    let expected_commitment: [u8; 32] = env::read();

    // === STEP 1: Verify responder's secret matches their on-chain commitment ===
    let mut hasher = Sha256::new();
    hasher.update(secret_x.to_le_bytes());
    hasher.update(secret_y.to_le_bytes());
    hasher.update(salt);
    let computed_commitment: [u8; 32] = hasher.finalize().into();
    assert_eq!(computed_commitment, expected_commitment,
        "Secret does not match on-chain commitment");

    // === STEP 2: Compute Manhattan distance (grid-wrapped) ===
    let grid_size: i32 = 100;

    let drop_offset_x = partial_dx + secret_x;
    let drop_offset_y = partial_dy + secret_y;

    // Wrap-aware absolute distance
    let abs_x = {
        let d = ((drop_offset_x % grid_size) + grid_size) % grid_size;
        d.min(grid_size - d)
    };
    let abs_y = {
        let d = ((drop_offset_y % grid_size) + grid_size) % grid_size;
        d.min(grid_size - d)
    };

    let distance: u32 = (abs_x + abs_y) as u32;

    // === STEP 3: Commit public outputs ===
    env::commit(&game_id);
    env::commit(&turn);
    env::commit(&distance);
    env::commit(&expected_commitment);
}
```

**Why this is secure:**
- The responder cannot lie about the distance because the circuit enforces the computation. If they input fake coordinates, the commitment hash won't match, and the proof is invalid.
- The querier's guess coordinates are hidden inside `partial_dx/dy` — the responder sees the offset but not the original guess (because they don't know `Sa`).

### 5.2 Gadget Guest Program

```rust
// risc0/dead_drop/methods/guest/src/bin/gadget.rs
#![no_main]
risc0_zkvm::guest::entry!(main);

use risc0_zkvm::guest::env;
use sha2::{Sha256, Digest};

fn main() {
    // Private inputs
    let secret_x: i32 = env::read();
    let secret_y: i32 = env::read();
    let salt: [u8; 32] = env::read();
    let opponent_commitment: [u8; 32] = env::read();

    // Public inputs
    let game_id: u32 = env::read();
    let player_commitment: [u8; 32] = env::read();
    let gadget_index: u32 = env::read();  // which of my 3 gadgets

    // Verify own commitment
    let mut hasher = Sha256::new();
    hasher.update(secret_x.to_le_bytes());
    hasher.update(secret_y.to_le_bytes());
    hasher.update(salt);
    let computed: [u8; 32] = hasher.finalize().into();
    assert_eq!(computed, player_commitment);

    // Derive gadget seed
    let mut seed_hasher = Sha256::new();
    // Canonical ordering: smaller commitment first
    if player_commitment < opponent_commitment {
        seed_hasher.update(player_commitment);
        seed_hasher.update(opponent_commitment);
    } else {
        seed_hasher.update(opponent_commitment);
        seed_hasher.update(player_commitment);
    }
    let seed: [u8; 32] = seed_hasher.finalize().into();

    // Derive the specific gadget ID
    let is_player_a = player_commitment < opponent_commitment;
    let offset = if is_player_a { 0 } else { 3 };
    let gadget_id = seed[(offset + gadget_index as usize) as usize] % 5;

    // Commit public outputs
    env::commit(&game_id);
    env::commit(&player_commitment);
    env::commit(&gadget_index);
    env::commit(&gadget_id);
}
```

---

## 6. Smart Contract Design (Soroban)

### 6.1 Contract Interface

```rust
#![no_std]
use soroban_sdk::*;

#[contract]
pub struct DeadDropContract;

#[contractimpl]
impl DeadDropContract {

    /// Initialize with verifier contract address and guest program image IDs
    pub fn init(
        env: Env,
        admin: Address,
        verifier_id: Address,          // Nethermind Groth16 verifier
        ping_image_id: BytesN<32>,     // RiscZero image ID for ping guest
        gadget_image_id: BytesN<32>,   // RiscZero image ID for gadget guest
    );

    /// Agent A creates a new game and stakes XLM
    pub fn create_game(env: Env, agent_a: Address) -> u32;  // returns game_id

    /// Agent B joins and stakes XLM
    pub fn join_game(env: Env, game_id: u32, agent_b: Address);

    /// Both players commit their secret hashes
    pub fn commit_secret(env: Env, game_id: u32, player: Address, commitment: BytesN<32>);

    /// Submit a ZK-verified ping result
    pub fn submit_ping(
        env: Env,
        game_id: u32,
        player: Address,       // the responder (prover)
        turn: u32,
        distance: u32,
        journal_hash: BytesN<32>,
        image_id: BytesN<32>,
        seal: Bytes,
    );

    /// Use a gadget with ZK proof of valid derivation
    pub fn use_gadget(
        env: Env,
        game_id: u32,
        player: Address,
        gadget_index: u32,
        gadget_id: u32,
        journal_hash: BytesN<32>,
        image_id: BytesN<32>,
        seal: Bytes,
    );

    /// Reveal secrets at game end for final verification
    pub fn reveal_secret(
        env: Env,
        game_id: u32,
        player: Address,
        secret_x: i32,
        secret_y: i32,
        salt: BytesN<32>,
    );

    /// Claim timeout victory if opponent goes AFK
    pub fn force_timeout(env: Env, game_id: u32, player: Address);

    /// Read game state
    pub fn get_game(env: Env, game_id: u32) -> Game;
}
```

### 6.2 Verification Flow (Following TypeZero's Pattern)

```rust
// Inside submit_ping:
fn verify_proof(
    env: &Env,
    verifier_id: &Address,
    journal_hash: &BytesN<32>,
    image_id: &BytesN<32>,
    seal: &Bytes,
) -> bool {
    // Reconstruct the expected journal from public outputs
    // (same pattern as TypeZero's leaderboard contract)

    // Cross-contract call to Nethermind verifier
    // The seal is prefixed with VERIFIER_SELECTOR_HEX (4 bytes)
    let verifier_client = VerifierClient::new(env, verifier_id);
    verifier_client.verify(image_id, journal_hash, seal)
}
```

### 6.3 Anti-Cheat Mechanisms

**ZK Proof Integrity:**
- Responder cannot fake distance: the circuit enforces correct computation tied to their commitment
- Image ID binding: only proofs from the registered guest programs are accepted
- Journal binding: public outputs (game_id, turn, distance, commitment) must match on-chain state

**Timeout Slashing:**
- `last_action_ledger` records when the last action occurred
- If `current_ledger - last_action_ledger > TIMEOUT_LEDGERS` (~5 minutes), the waiting player can call `force_timeout()`
- The AFK player's stake is forfeit; the active player wins

**Reveal Verification:**
- At game end, both secrets are revealed
- The contract recomputes `SHA256(secret || salt)` and checks against stored commitments
- Failure to reveal within the reveal window = forfeit

---

## 7. P2P Communication Layer

### 7.1 Dual-Channel Architecture

**Primary: WebRTC DataChannel**
- Direct browser-to-browser communication
- Sub-second latency for ping/response exchange
- Signaling via a lightweight signaling server (or Stellar Events for truly serverless signaling)

**Fallback: Stellar Contract Events**
- Player A emits a `PingQuery` event when submitting on-chain
- Player B's client watches for events on the game's contract
- Slower (~5 second block times) but fully decentralized
- Used for dispute resolution: if B claims they never received A's query, A can point to the on-chain event

### 7.2 Message Protocol

```typescript
// WebRTC messages between players
interface PingQuery {
    type: "ping_query";
    game_id: number;
    turn: number;
    partial_dx: number;  // Gx - Xa (querier's offset)
    partial_dy: number;  // Gy - Ya
    timestamp: number;
}

interface PingResponse {
    type: "ping_response";
    game_id: number;
    turn: number;
    distance: number;
    // Proof artifacts for on-chain submission
    seal_hex: string;
    journal_hash_hex: string;
    image_id_hex: string;
}
```

`partial_dx` and `partial_dy` are protocol values used for proof generation and verification. They are not world coordinates and must not be rendered as exact opponent markers in the UI.

### 7.3 Auto-Responder

The responding player's browser runs a background worker that:
1. Listens for `PingQuery` messages on the WebRTC channel
2. Automatically sends `(private inputs)` to the Proving Service
3. Waits for proof generation (~30-60 seconds)
4. Returns `PingResponse` to the querier
5. Submits the proof on-chain

This happens without manual intervention — the player just watches the distance results appear on their opponent's UI.

---

## 8. Security Model

### 8.1 Trust Analysis

| Actor | Can They Cheat? | Why Not? |
|-------|----------------|----------|
| Player A | Cannot learn B's secret | B's secret only exists as a private input to the ZK proof; only the commitment hash is on-chain |
| Player B | Cannot lie about distance | The ZK circuit enforces correct computation; a fake distance produces an invalid proof |
| Proving Service | Cannot fabricate results | Proof is deterministic: same inputs always produce the same outputs. Image ID binds to the specific guest program. |
| Proving Service | Can refuse to generate proofs (DoS) | Mitigated by timeout slashing: if no proof is submitted within T minutes, the opponent wins by default |
| On-chain observer | Cannot determine the Drop location | Only commitment hashes and verified distances are stored; secrets are never on-chain until game end |

### 8.2 Information Leakage Analysis

**What Player B learns from a ping:**
- B sees `Da = (Gx - Xa, Gy - Ya)` — the partial offset
- B does NOT know `Xa` or `Ya`, so B cannot determine `Gx` or `Gy`
- B DOES learn the distance result (they compute it)
- Over multiple pings, B can observe the distance values but cannot triangulate A's guesses without knowing `Sa`
- B should not receive or store A's secret share in local runtime state
- Therefore, B cannot reconstruct A's exact ping coordinate during active play; UI must show uncertainty instead of a point

**What a blockchain observer learns:**
- Verified distances for each turn
- With enough distances, an observer could potentially narrow down the Drop location
- Mitigation: distances are quantized into temperature zones in the UI (not exact values), though exact values are on-chain for verification

### 8.3 What the Proving Service Cannot Do

Following TypeZero's security model:
- ✅ Can refuse to generate proofs (DoS) → Mitigated by timeout
- ✅ Can be slow → Player experience issue, not security issue
- ❌ Cannot submit fake distances → Proof binds to inputs
- ❌ Cannot submit on behalf of wrong player → `player` address in journal, contract enforces `invoker == player`
- ❌ Cannot modify computation → Image ID verification prevents proof substitution

---

## 9. Frontend Design

### 9.1 Game UI Concept

```
┌─────────────────────────────────────────────────────────┐
│  DEAD DROP  ░░  Agent: Falcon  ░░  Turn 7/15  ░░ ⏱ 4:32 │
├─────────────────────────────────────────────────────────┤
│                                                          │
│   ┌────────────────────────────┐  ┌──────────────────┐  │
│   │                            │  │  PING HISTORY     │  │
│   │     100 × 100 GRID MAP    │  │                    │  │
│   │                            │  │  T1: COLD (47)    │  │
│   │   Click to place your      │  │  T3: WARM (18)    │  │
│   │   next ping target         │  │  T5: WARM (12)    │  │
│   │                            │  │  T7: HOT  (4) !!  │  │
│   │     ◉ ← your last ping    │  │                    │  │
│   │     ◎ ← previous pings    │  │  Opponent:         │  │
│   │                            │  │  T2: COLD          │  │
│   │                            │  │  T4: COOL          │  │
│   │                            │  │  T6: WARM          │  │
│   └────────────────────────────┘  └──────────────────┘  │
│                                                          │
│   ┌──────────────────────────────────────────────────┐  │
│   │  GADGETS: [🛰 Sat-Link] [📡 Intercept] [💨 Used]  │  │
│   └──────────────────────────────────────────────────┘  │
│                                                          │
│   [ SUBMIT PING ]              Stake: 100 XLM each      │
└─────────────────────────────────────────────────────────┘
```

### 9.2 UI Theme: Cold War Spy

- Dark background with green/amber terminal aesthetics
- Radar sweep animation when waiting for ping response
- "CLASSIFIED" watermarks on game state
- Sound effects: radar beep (ping sent), sonar ping (distance received), alarm (HOT zone)
- Distance visualization: concentric rings on the map showing temperature zones
- Opponent pings render as a "classified uncertainty overlay" (no exact coordinate marker)

### 9.3 Coordinate Visibility Rules

- Your own pings: exact coordinates can be rendered locally after decoding with your own secret.
- Opponent pings: coordinate remains unknown by design; only distance/temperature feedback is shown.
- If the UI receives `partial_dx/dy`, it must treat them as non-display protocol values.
- Exact opponent coordinates can only appear after an explicit post-game reveal policy.

---

## 10. Implementation Plan (14 Days)

### Phase 1: Foundation (Days 1-3)

**Goal:** Two players can stake XLM and commit secret hashes on Stellar Testnet.

**Tasks:**
- [ ] Fork TypeZero's project structure as boilerplate
- [ ] Design and implement the Dead Drop Soroban contract (game state, escrow, commitments)
- [ ] Write unit tests for contract state machine: `create_game → join_game → commit_secret`
- [ ] Deploy Nethermind Groth16 verifier on Testnet (or locate existing deployment)
- [ ] Deploy Dead Drop contract on Testnet, initialize with verifier address
- [ ] Basic frontend: wallet creation, game creation/joining, secret commitment

**Deliverable:** Working contract on Testnet; two wallets can create a game and commit secrets.

### Phase 2: ZK Proving (Days 4-7)

**Goal:** The Ping Guest Program generates valid proofs that the contract accepts.

**Tasks:**
- [ ] Set up RiscZero development environment (`rzup`, `cargo risczero`)
- [ ] Write the Ping Guest Program (distance computation with commitment verification)
- [ ] Write the RiscZero Host (receives private inputs, runs guest, returns Groth16 artifacts)
- [ ] Adapt TypeZero's backend proving service for Dead Drop's input format
- [ ] Integration test: generate a proof locally, submit to contract, verify on-chain
- [ ] Handle the `VERIFIER_SELECTOR_HEX` prefix (follow TypeZero's pattern exactly)

**Deliverable:** End-to-end proof: generate distance proof → submit to contract → on-chain verification passes.

**Key Risk:** Proof generation time. RiscZero Groth16 proofs can take 30-120 seconds on CPU. Test early and plan the UX around this latency (progress indicator, "generating proof..." state).

### Phase 3: P2P & Game Loop (Days 8-10)

**Goal:** Two players can play a full game through the browser.

**Tasks:**
- [ ] Implement WebRTC signaling and DataChannel connection between two browsers
- [ ] Build the Auto-Responder: background worker that receives queries, calls proving service, returns responses
- [ ] Implement the full turn loop: A guesses → B auto-responds → proof submitted → distance displayed → turn advances
- [ ] Add the ping history panel and temperature zone visualization
- [ ] Enforce "no opponent secret locally" in runtime state and rendering paths
- [ ] Render opponent ping uncertainty overlay (instead of exact map markers)
- [ ] Implement the reveal phase (game end, secret reveal, winner determination)
- [ ] Implement `force_timeout()` for AFK protection

**Deliverable:** Two browsers can play a complete game of Dead Drop on Testnet.

### Phase 4: Gadgets & Polish (Days 11-12)

**Goal:** Gadgets work, the game feels good.

**Tasks:**
- [ ] Write the Gadget Guest Program
- [ ] Implement gadget UI (inventory, activation, effects)
- [ ] Implement at least Sat-Link (quadrant peek) and Intercept (learn opponent's distance)
- [ ] Add `gadget_usage_mask` to contract to prevent reuse
- [ ] Sound effects and visual polish (radar, temperature zones, spy theme)
- [ ] Add clear UX copy/tooltips explaining why opponent coordinates are unknown
- [ ] Handle edge cases: both players online/offline, reconnection, proof generation failures

### Phase 5: Demo & Documentation (Days 13-14)

**Goal:** Hackathon-ready demo with documentation.

**Tasks:**
- [ ] End-to-end testing on Stellar Testnet with multiple game scenarios
- [ ] Record a demo video showing a complete game
- [ ] Write README with setup instructions
- [ ] Prepare presentation: focus on the "Nuclear Keys" mechanic and the ZK pipeline
- [ ] Document the security model and trust assumptions clearly

---

## 11. Risk Mitigation

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Proof generation too slow (>2 min) | Medium | High | Use `RISC0_DEV_MODE=1` for hackathon demo; show real proofs in video. Optimize guest program to minimize cycles. |
| Nethermind verifier not accessible on Testnet | Low | Critical | TypeZero has already validated this works. Deploy our own instance using their deployment scripts. |
| WebRTC connection failures | Medium | Medium | Fall back to Stellar Events for all communication (slower but reliable). |
| Guest program bugs | High | High | Write extensive unit tests for the distance computation. Test edge cases: grid wrapping, distance=0, max distance. |
| Soroban resource limits exceeded | Low | Medium | The contract is lightweight (hash checks + cross-contract call). Keep state minimal. |

---

## 12. Hackathon Judging Angle

### Why Dead Drop Wins

1. **Novel ZK Use Case:** Not just "prove a score" (like TypeZero) — this is trustless hidden information in a 2-player game. It solves the "Mental Poker" problem for location-based games.

2. **Built on Proven Infrastructure:** We're not handwaving about ZK on Stellar. The Nethermind verifier is deployed, the RiscZero pipeline is proven, and TypeZero shows it works end-to-end.

3. **Stellar-Native:** Uses XLM staking, Soroban contracts, and Stellar's fast finality. Demonstrates that Stellar can support sophisticated game theory applications, not just payments.

4. **The "Nuclear Keys" Narrative:** The split-secret mechanic is easy to explain, intellectually compelling, and demonstrates a deep understanding of cryptographic primitives.

5. **Real Game, Not Just a Proof of Concept:** Two people can actually sit down and play this. It's fun, it's competitive, and it's provably fair.

---

## 13. Future Extensions (Post-Hackathon)

- **Multiplayer:** Extend to N-player games using N-of-N secret sharing
- **Real-World Coordinates:** GPS-based Dead Drops with geofencing
- **Tournament System:** Bracket-style competition with progressive stakes
- **NFT Rewards:** Unique "mission completion" NFTs for winners
- **Mobile Client:** React Native with background proving
- **Client-Side Proving:** As WASM-based provers mature, eliminate the backend entirely
- **Integration with Certus Protocol:** Use conditional tokens for match stakes, enabling more complex betting structures

---

## 14. Conclusion

Dead Drop demonstrates that Stellar's Soroban platform, combined with RiscZero's zkVM and the Nethermind Groth16 verifier, can support sophisticated game-theoretic applications that were previously impossible without a trusted server.

The "Nuclear Keys" mechanic — splitting a secret between two adversarial players — creates a game where **the information exists nowhere, yet can be found by anyone.** This is the ultimate demonstration of Zero-Knowledge privacy as a gameplay primitive on the Stellar network.

By building on TypeZero's proven RiscZero → Groth16 → Soroban pipeline, Dead Drop is not a theoretical exercise — it's a buildable, playable game that pushes the boundaries of what's possible in trustless P2P gaming.

---

*Built for the Stellar Hackathon 2025*
*License: MIT*
