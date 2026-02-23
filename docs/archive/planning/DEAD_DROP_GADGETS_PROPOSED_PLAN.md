# Dead Drop Gadgets v1 (Public-Ping-Compatible) Proposed Plan

<proposed_plan>
## Title
Dead Drop Gadget Mechanics v1 for Public Ping Gameplay

## Summary
Implement a zk-poker gadget system that fits the reality that all ping submissions are public.

Core rules:
- Total gadget catalog: 6 gadget types.
- Each player receives exactly 2 hidden gadgets per match.
- No duplicates in a player's 2-gadget loadout.
- Gadget use is pre-ping only.
- Max one gadget activation per ping.
- Each gadget slot is one-time use.
- Gadget identity is hidden until activated, then publicly revealed.
- No gadget directly reduces opponent ping effectiveness.

Design intent:
- Preserve strategic depth through self-focused risk/reward and planning powers.
- Keep effects deterministic and contract-verifiable.
- Keep hidden-hand "zk poker" behavior via proof-based ownership checks.

---

## Public APIs and Interface Changes

### Contract (`contracts/dead-drop/src/lib.rs`)

1. Extend constructor:
- `__constructor(env, admin, game_hub, verifier_id, randomness_verifier_id, gadget_verifier_id)`

2. Extend game creation methods with gadget commitments:
- `start_game(..., randomness_output, drop_commitment, randomness_signature, player1_gadget_secret_commitment, player2_gadget_secret_commitment)`
- `open_game(session_id, host, host_points, host_gadget_secret_commitment)`
- `join_game(session_id, joiner, joiner_points, randomness_output, drop_commitment, randomness_signature, joiner_gadget_secret_commitment)`

3. Add gadget ping method:
- `submit_ping_with_gadget(session_id, player, turn, distance, ping_x, ping_y, ping_proof, ping_public_inputs, gadget_activation)`

4. Keep existing `submit_ping` unchanged for non-gadget turns.

### New Types

- `enum GadgetId`
  - `QuadrantCall = 0`
  - `AxisCall = 1`
  - `HeatBet = 2`
  - `ImprovementBurst = 3`
  - `EdgeSweep = 4`
  - `AllInVector = 5`

- `struct GadgetActivation`
  - `slot: u32` // 0 or 1
  - `gadget_id: u32` // 0..5
  - `param: u32` // gadget-specific input
  - `proof: Bytes`
  - `public_inputs: Vec<BytesN<32>>`

### New/Updated Storage Fields

- `DataKey::GadgetVerifierId`
- `Game.randomness_output: BytesN<32>`
- `Game.player1_gadget_secret_commitment: BytesN<32>`
- `Game.player2_gadget_secret_commitment: BytesN<32>`
- `Game.player1_gadget_used_mask: u32` // bit0=slot0, bit1=slot1
- `Game.player2_gadget_used_mask: u32`

### New Errors

- `InvalidGadgetSlot`
- `InvalidGadgetId`
- `GadgetAlreadyUsed`
- `GadgetNotAllowedAtThisTime`
- `GadgetPublicInputsInvalid`
- `GadgetProofVerificationFailed`
- `InvalidGadgetParam`

### New Events

- `("gadget_used", session_id)` with data:
  - `(player, turn, gadget_id, slot, param, condition_hit, distance_delta)`

---

## Gadget Set (Revised for Public Ping Reality)

All effects are self-focused. No opponent debuffs.

1. `QuadrantCall` (ID 0)
- Pre-ping choose global quadrant param (`0..3`).
- If hidden drop is in chosen quadrant: `effective_distance -= 5`.
- Else no change.

2. `AxisCall` (ID 1)
- Pre-ping choose axis-half param (`0..3`):
  - `0 = X[0..49]`, `1 = X[50..99]`, `2 = Y[0..49]`, `3 = Y[50..99]`.
- If true: `effective_distance -= 4`.
- Else no change.

3. `HeatBet` (ID 2)
- Pre-ping choose zone param (`0..3`):
  - `0 = 0..5`, `1 = 6..15`, `2 = 16..30`, `3 = 31..100`.
- If raw distance falls in chosen zone: `effective_distance -= 3`.
- Else `effective_distance += 1`.

4. `ImprovementBurst` (ID 3)
- No param.
- If this raw distance improves player's pre-turn best: `effective_distance -= 3`.
- Else no change.

5. `EdgeSweep` (ID 4)
- No param.
- Valid only if `ping_x == 0 || ping_x == 99 || ping_y == 0 || ping_y == 99`.
- If valid: `effective_distance -= 4`.
- If invalid: reject with `InvalidGadgetParam`.

6. `AllInVector` (ID 5)
- No param.
- If raw distance `<= 8`: immediate win.
- Else `effective_distance += 5`.

Constants:
- `QUADRANT_CALL_BONUS = 5`
- `AXIS_CALL_BONUS = 4`
- `HEAT_BET_BONUS = 3`
- `HEAT_BET_MISS_PENALTY = 1`
- `IMPROVEMENT_BONUS = 3`
- `EDGE_SWEEP_BONUS = 4`
- `ALL_IN_THRESHOLD = 8`
- `ALL_IN_MISS_PENALTY = 5`

Clamp:
- `effective_distance` is clamped to `[0, MAX_DISTANCE]`.

---

## Deterministic Hidden Loadout Derivation (2 from 6, no duplicates)

Each player provides a 32-byte private `gadget_secret` off-chain and publishes commitment on-chain.

Commitment:
- `player_gadget_secret_commitment = sha256(gadget_secret)`

Circuit/derivation seed:
- `seed = keccak256(session_id || player_role || player_address || randomness_output || drop_commitment || gadget_secret)`

Loadout:
- `g0 = seed[0] % 6`
- `c = seed[1] % 5`
- `g1 = if c >= g0 { c + 1 } else { c }`
- Slots:
  - `slot 0 -> g0`
  - `slot 1 -> g1`

This guarantees:
- exactly 2 gadgets
- both in `[0..5]`
- no duplicate per player
- hidden loadout unless a slot is used

---

## ZK Proof Design

Add a dedicated circuit: `circuits/dead_drop_gadget/src/main.nr`.

### Goal
One proof validates:
1. gadget ownership (slot maps to claimed gadget ID),
2. one-time-use eligibility inputs consistency,
3. hidden-condition evaluation for hidden-dependent gadgets (`QuadrantCall`, `AxisCall`).

### Private witness
- `drop_x`, `drop_y`, `drop_salt`
- `gadget_secret`

### Public inputs
- `session_id`
- `turn`
- `player_role`
- `player_address`
- `slot`
- `gadget_id`
- `param`
- `ping_x`
- `ping_y`
- `raw_distance`
- `drop_commitment`
- `randomness_output`
- `player_gadget_secret_commitment`
- `condition_hit` // boolean output as 0/1

### Circuit checks
- `Poseidon2(drop_x, drop_y, drop_salt) == drop_commitment`
- `wrappedManhattan(ping_x, ping_y, drop_x, drop_y) == raw_distance`
- `sha256(gadget_secret) == player_gadget_secret_commitment`
- derive `g0/g1` from seed formula and verify `slot/gadget_id`.
- compute `condition_hit` deterministically for gadget types:
  - `QuadrantCall`, `AxisCall`: hidden-coordinate-dependent.
  - other gadgets: `condition_hit = 1` (contract evaluates public conditions).

### On-chain verification
- Contract reconstructs expected gadget public inputs and compares exactly.
- Contract calls `GadgetVerifierClient.verify_proof`.
- On failure return `GadgetProofVerificationFailed`.

---

## Contract Execution Flow

### `submit_ping_with_gadget` flow

1. Authenticate player and load game.
2. Validate active status, turn, ping bounds, base ping input invariants.
3. Verify ping proof (existing verifier) exactly as in `submit_ping`.
4. Validate gadget activation:
   - slot in `{0,1}`
   - gadget ID in `{0..5}`
   - slot unused for this player
   - one gadget max this call
5. Verify gadget public inputs and gadget proof.
6. Evaluate gadget effect:
   - compute `distance_delta` and `all_in_win` from gadget rules.
7. Compute `effective_distance = clamp(raw_distance + distance_delta)`.
8. Update player best distance with `effective_distance`.
9. Mark gadget slot as used (bitmask update).
10. Emit `ping` event and `gadget_used` event.
11. Resolve win paths:
   - if `raw_distance == 0`, player wins immediately.
   - if `AllInVector` and `raw_distance <= 8`, player wins immediately.
12. If no win, continue normal turn progression and max-turn resolution.
13. Extend TTL for updated game storage.

Note:
- Game Hub lifecycle remains unchanged: `start_game` before game state creation; `end_game` before finalization on completion/timeout.

---

## Frontend Plan (`dead-drop-frontend`)

### New services

1. `deadDropGadgetService.ts`
- generate `gadget_secret`
- compute `gadget_secret_commitment`
- local derive slot-0/slot-1 gadget IDs for UI
- manage used slot status from chain game state

2. `deadDropGadgetNoirService.ts`
- compile/load `dead_drop_gadget` artifact
- produce gadget proof + public inputs for selected gadget activation

### UI changes (`DeadDropGame.tsx`)

1. Setup phase
- generate local gadget secret once per session
- include commitment in `open_game` / `join_game` / `start_game` flows

2. Gameplay phase
- inventory panel shows 2 hidden-derived gadgets for self
- used slots disabled
- pre-ping gadget selector (0 or 1 selection)
- param input controls for gadgets that require params:
  - `QuadrantCall`: 0..3
  - `AxisCall`: 0..3
  - `HeatBet`: 0..3

3. Submit path
- if no gadget selected: existing `submit_ping`
- if gadget selected:
  - generate ping proof (existing)
  - generate gadget proof (new)
  - call `submit_ping_with_gadget`

4. Match history
- show gadget reveal badge on used turn
- show effect result:
  - hit/miss
  - distance delta applied
  - slot consumed

### Bindings

- regenerate with `bun run bindings dead-drop`
- replace `dead-drop-frontend/src/games/dead-drop/bindings.ts`

---

## Testing and Acceptance Criteria

### Contract unit tests (`contracts/dead-drop/src/test.rs`)

Add tests for:
1. Loadout derivation:
- slot 0/1 valid and distinct.
2. Ownership proof:
- valid proof accepted.
- wrong gadget ID for slot rejected.
- wrong slot rejected.
3. One-time use:
- reusing same slot fails with `GadgetAlreadyUsed`.
4. Gadget-specific behavior:
- `QuadrantCall` hit/miss branches.
- `AxisCall` hit/miss branches.
- `HeatBet` hit/miss branches.
- `ImprovementBurst` improved/not improved branches.
- `EdgeSweep` valid/invalid coordinate branches.
- `AllInVector` success/fail branches.
5. Turn/game integrity:
- gadget + ping still enforces turn order.
- max turns still resolves deterministically.
- immediate win paths still call Game Hub `end_game`.
6. Compatibility:
- legacy `submit_ping` still works in sessions with gadget commitments.

### Frontend tests

1. Inventory render:
- two gadgets shown, slots disabled after use.
2. Action validation:
- invalid params blocked client-side.
3. Submit routing:
- with gadget -> `submit_ping_with_gadget`.
- without gadget -> `submit_ping`.
4. UX correctness:
- gadget reveal and effect details appear in history.
- transaction failures do not desync local used-slot UI.

### Acceptance criteria

- Each player receives exactly 2 unique hidden gadgets from 6.
- No opponent-effectiveness debuffs exist in gadget set.
- Gadget use is pre-ping, one per ping, one-time per slot.
- Gadget ownership and hidden-condition checks are ZK-verified on-chain.
- Game Hub lifecycle and 30-day temporary storage TTL behavior remain correct.

---

## Rollout Sequence

1. Contract type/error/storage additions.
2. New gadget verifier wiring and proof validation helpers.
3. `submit_ping_with_gadget` implementation.
4. Gadget Noir circuit and proof service integration.
5. Frontend inventory/activation UX.
6. Binding regeneration and frontend contract method wiring.
7. Full test pass:
- `cargo test -p dead-drop`
- frontend build and interaction tests.

---

## Assumptions and Defaults

- Grid stays 100x100 toroidal.
- Existing ping proof/public-input schema remains unchanged.
- Gadget proof is separate from ping proof.
- `submit_ping` remains for backwards compatibility.
- Per-player gadget secret is client-generated 32 random bytes.
- All constants above are v1 defaults and can be tuned without interface changes.
</proposed_plan>
