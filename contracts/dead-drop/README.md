# Dead Drop Contract

Dead Drop is a 1v1 Soroban game contract where each player commits a hidden grid coordinate and players alternate submitting ZK-verified ping results until someone finds the drop or the game times out.

## Overview

- Grid: `100 x 100` toroidal map.
- Commitments: each player stores `Poseidon2(x, y, salt)` → 32 bytes (BN254 field element).
- Ping proof: contract verifies an UltraHonk proof against the responder commitment.
- Lifecycle: integrated with Game Hub `start_game` / `end_game`.
- Storage: temporary storage with TTL extension on each game write.

## Constructor

`__constructor(env, admin, game_hub, verifier_id)`

Initializes:
- `Admin`
- `GameHubAddress`
- `VerifierId`

## Core Methods

### Match setup

- `open_game(session_id, host, host_points)`
  - Single-sig lobby creation (Player 1).
  - Stores lobby state; returns room code (= `session_id`).
  - Rejects non-positive `host_points`.

- `join_game(session_id, joiner, joiner_points)`
  - Single-sig lobby join (Player 2).
  - Rejects self-play and non-positive `joiner_points`.
  - Calls Game Hub `start_game` and creates the active session.

- `start_game(session_id, player1, player2, player1_points, player2_points)`
  - Two-sig variant (legacy/dev). Requires auth from both players.
  - Rejects self-play and duplicate sessions.
  - Calls Game Hub `start_game` before writing game state.

### Gameplay

- `commit_secret(session_id, player, commitment)`
  - Stores player commitment (32-byte Poseidon2 hash).
  - Transitions `Created -> Committing -> Active`.

- `submit_ping(session_id, player, turn, distance, partial_dx, partial_dy, proof, public_inputs)`
  - Validates turn order, status, bounds, and max distance.
  - Public inputs (6 × 32-byte big-endian field elements):
    `[session_id, turn, partial_dx, partial_dy, responder_commitment, expected_distance]`
  - Calls UltraHonk verifier contract with proof bytes + public inputs.
  - Emits `"ping"` event with `(player, turn, distance, partial_dx, partial_dy)`.
  - Ends game immediately on `distance == 0`.
  - Ends at turn cap (`30`) via best-distance comparison (player1 wins ties).
  - Calls Game Hub `end_game` before returning winner.

- `force_timeout(session_id, player)`
  - Allows either player to claim timeout after inactivity threshold (`600` ledgers).
  - Marks timeout winner and reports Game Hub `end_game`.

### Read methods

- `get_game(session_id) -> Game`
- `get_lobby(session_id) -> Lobby`

### Admin methods

- `get_admin`, `set_admin`
- `get_hub`, `set_hub`
- `set_verifier`
- `upgrade(new_wasm_hash)`

## ZK Proof System

Proofs are generated **entirely client-side** in the browser using:
- **Noir** (`@noir-lang/noir_js ^1.0.0-beta.18`) — circuit witness generation
- **Barretenberg UltraHonk** (`@aztec/bb.js ^2.1.11`) — WASM-based proof generation

The Noir circuit verifies:
1. `Poseidon2(responder_x, responder_y, salt) == expected_commitment`
2. `wrappedManhattan(partial_dx, partial_dy, responder_x, responder_y) == expected_distance`

No backend prover is required. The responder's browser generates the proof and sends it
to the pinger via WebRTC / Session Push relay.

## Game Statuses

- `Created`
- `Committing`
- `Active`
- `Completed`
- `Timeout`

## Storage and TTL

- Session and lobby state use temporary storage.
- TTL target: ~30 days (`518,400` ledgers), refreshed on every game write.

## Build and Test

From repo root:

```bash
bun run build dead-drop
cargo test -p dead-drop
```
