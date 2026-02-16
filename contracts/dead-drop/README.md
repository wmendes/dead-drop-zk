# Dead Drop Contract

Dead Drop is a 1v1 Soroban game contract where players race to find a hidden
location on a `100 x 100` toroidal grid.

## Overview

- Hidden drop commitment: fixed at game start using verifier-backed randomness artifacts.
- Ping flow: each turn submits exact public ping coordinates plus a ZK proof.
- Proof system: Noir + UltraHonk verifier contract.
- Lifecycle: integrated with Game Hub `start_game` / `end_game`.
- Storage: temporary storage with TTL extension on each game write.

## Constructor

`__constructor(env, admin, game_hub, verifier_id, randomness_verifier_id)`

Initializes:
- `Admin`
- `GameHubAddress`
- `VerifierId` (UltraHonk proof verifier)
- `RandomnessVerifierId` (randomness artifact verifier)

## Core Methods

### Match setup

- `open_game(session_id, host, host_points)`
  - Single-sig lobby creation (Player 1).

- `join_game(session_id, joiner, joiner_points, randomness_output, drop_commitment, randomness_signature)`
  - Single-sig lobby join (Player 2).
  - Verifies randomness artifacts via randomness-verifier contract.
  - Calls Game Hub `start_game` and creates an `Active` game.

- `start_game(session_id, player1, player2, player1_points, player2_points, randomness_output, drop_commitment, randomness_signature)`
  - Two-sig legacy path.
  - Also verifies randomness artifacts and starts game directly as `Active`.

### Gameplay

- `submit_ping(session_id, player, turn, distance, ping_x, ping_y, proof, public_inputs)`
  - Public inputs layout:
    `[session_id, turn, ping_x, ping_y, drop_commitment, expected_distance]`
  - Verifies UltraHonk proof and emits ping event with exact coordinates.
  - Ends immediately on `distance == 0`, otherwise after max turns by best distance.

- `force_timeout(session_id, player)`
  - Claims timeout after inactivity threshold (`600` ledgers).

### Read methods

- `get_game(session_id) -> Game`
- `get_lobby(session_id) -> Lobby`

### Admin methods

- `get_admin`, `set_admin`
- `get_hub`, `set_hub`
- `set_verifier`
- `get_randomness_verifier`, `set_randomness_verifier`
- `upgrade(new_wasm_hash)`

## Storage and TTL

- Session and lobby state use temporary storage.
- TTL target: ~30 days (`518,400` ledgers), refreshed on every game write.

## Build and Test

From repo root:

```bash
bun run build dead-drop
cargo test -p dead-drop
```
