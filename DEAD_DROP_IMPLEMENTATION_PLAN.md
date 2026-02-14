# Dead Drop Implementation Plan (Deep Dive)

Date: 2026-02-11

Inputs reviewed:
- `NEXT_STEPS.md`
- `Game Project Feasibility Whitepaper.md`
- `contracts/dead-drop/src/lib.rs`
- `contracts/dead-drop/src/test.rs`
- `dead-drop-frontend/src/games/dead-drop/DeadDropGame.tsx`
- `dead-drop-frontend/src/games/dead-drop/deadDropService.ts`
- `dead-drop-frontend/src/hooks/useWallet.ts`
- `dead-drop-frontend/src/hooks/useWalletStandalone.ts`
- `scripts/deploy.ts`
- `typezero-reference/` (backend + risc0 + contract patterns)

---

## 1. Executive Summary

**Last updated: 2026-02-14** (post-Noir refactor)

The codebase has completed the core ZK and P2P layers. The game is now past mock-dev for proving:

**DONE:**
1. ZK proving path: Noir circuit (`circuits/dead_drop/`) + client-side UltraHonk proving via `@aztec/bb.js`. No backend prover required — all proving runs in-browser via WASM.
2. Commitment scheme: `Poseidon2(x, y, salt)` via `@zkpassport/poseidon2` — matches Noir circuit exactly.
3. P2P transport: WebRTC peer service + Session Push relay for proof request/response exchange.
4. Lobby system: `open_game` (single-sig, room code) + `join_game` (single-sig, triggers Game Hub).
5. Sound engine: ambient loop + gameplay sounds via Tone.js.

**Remaining P0s (blocking production):**
1. On-chain UltraHonk verifier not yet deployed on Testnet — `submit_ping` still uses mock verifier.
2. Frontend `submit_ping` path still uses mock proof artifacts — must be wired to `deadDropNoirService.provePingNoir()`.
3. Relay backend not deployed in production (local only).

**Remaining P1s:**
4. Reveal phase not yet in contract or frontend.
5. Passkey / Smart Account integration not yet implemented.
6. Auto-responder E2E (WebRTC prove-and-return loop) not fully tested across two real browsers.

This plan continues to prioritize the production vertical slice:
`real Noir proof → on-chain UltraHonk verifier → trustless ping submission → two-browser gameplay → passkey/smart accounts`.

---

## 2. Code Review Findings (Ordered by Severity)

## P0 Findings

1. Proof verification failure panics instead of returning a typed contract error.
- Location: `contracts/dead-drop/src/lib.rs:724` and `contracts/dead-drop/src/lib.rs:743`
- Impact: verifier errors become generic panics, harder client handling, inconsistent with declared `Error::ProofVerificationFailed`.
- Required fix: make `verify_proof` return `Result<(), Error>` and propagate `Error::ProofVerificationFailed`.

2. Frontend ping submission is still mock-based.
- Location: `dead-drop-frontend/src/games/dead-drop/DeadDropGame.tsx:484`
- Location: `dead-drop-frontend/src/games/dead-drop/DeadDropGame.tsx:497`
- Impact: gameplay is non-trustless and does not reflect real proving pipeline.
- Required fix: replace local/mock distance + dummy `seal` with backend/peer-sourced real proof artifacts.

3. Coordinates are not bound into journal hash verification.
- Location: `contracts/dead-drop/src/lib.rs:290` (current journal layout)
- Location: `contracts/dead-drop/src/lib.rs:351` (journal reconstruction)
- Impact: on-chain event coordinates `x,y` can diverge from proof-bound computation.
- Required fix: update journal schema to include coordinate data (or proof-bound partial offsets), then verify against submitted values.

4. Deployment path is hardwired to mock verifier + static image id.
- Location: `scripts/deploy.ts:334`
- Location: `scripts/deploy.ts:340`
- Impact: no production-ready pathway for real verifier/image id/selector pipeline.
- Required fix: add deploy mode and config for real verifier and image id.

5. Active wallet hook in app is dev-only.
- Location: `dead-drop-frontend/src/hooks/useWallet.ts:107`
- Impact: production users cannot sign transactions in current app path.
- Required fix: introduce wallet adapter abstraction and route app to real wallet/passkey adapters.

## P1 Findings

1. Event sync strategy is heavy and fragile at scale.
- Location: `dead-drop-frontend/src/games/dead-drop/deadDropService.ts:449`
- Location: `dead-drop-frontend/src/games/dead-drop/deadDropService.ts:456`
- Impact: polling last 10k ledgers every cycle with `limit: 200` may miss/over-fetch events.
- Required fix: track cursor or last ledger seen per session and fetch incrementally.

2. Session overwrite risk in `start_game` path (no duplicate session guard).
- Location: `contracts/dead-drop/src/lib.rs:219`
- Impact: direct `start_game` can overwrite existing session state if reused `session_id`.
- Required fix: reject if `Game(session_id)` or `Lobby(session_id)` already exists.

3. Contract input validation gaps.
- Location: `contracts/dead-drop/src/lib.rs:166` (points)
- Location: `contracts/dead-drop/src/lib.rs:291` (distance/x/y)
- Impact: invalid points/coordinates can enter state/events unless blocked by upstream components.
- Required fix: enforce points > 0, coordinate bounds, and distance bounds (defense-in-depth).

4. Duplicate refresh calls in join/open flows.
- Location: `dead-drop-frontend/src/games/dead-drop/DeadDropGame.tsx:441`
- Location: `dead-drop-frontend/src/games/dead-drop/DeadDropGame.tsx:442`
- Impact: redundant state churn/network work.
- Required fix: remove duplicate calls and centralize refresh trigger points.

## P2 Findings

1. Deprecated event API usage warning.
- Location: `contracts/dead-drop/src/lib.rs:380`
- Impact: technical debt and future SDK compatibility risk.
- Required fix: migrate to `#[contractevent]` pattern.

2. Contract README is outdated and describes a different game.
- Location: `contracts/dead-drop/README.md`
- Impact: onboarding and operational confusion.
- Required fix: rewrite README for Dead Drop contract and current flow.

---

## 3. Current Codebase Analysis

## 3.1 Contract (`contracts/dead-drop`)

What is strong today:
- Correct Game Hub lifecycle integration is present in core paths (`start_game`, `join_game`, `submit_ping` game-end, `force_timeout`).
- Temporary storage + TTL extension is consistently used.
- State machine and turn logic are clear and covered by unit tests.
- Lobby flow (`open_game` -> `join_game`) avoids requiring both players online for initial auth exchange.

What is missing vs plan:
- No reveal phase contract methods.
- No gadget model/mask/effects.
- No escrow/stake settlement path in contract (points are reported to hub, not escrowed in this contract).
- No explicit real-verifier selector handling strategy (currently delegated to caller payload).

## 3.2 Frontend (`dead-drop-frontend`)

What is strong today:
- Polished lobby/commit/turn/game-over UX.
- Good service layer separation (`DeadDropService`) from UI component.
- Multi-sig helper tooling exists (auth entry import/inject/finalize) for dev flows.

What is missing vs plan:
- Real ZK path not wired.
- No P2P signaling/data channel.
- Auto-responder not implemented.
- Active app path uses dev wallet hook (`useWallet`), not standalone real wallet hook.
- Reveal and gadgets absent.

## 3.3 ZK/Backend Infrastructure

Current state:
- `zk-circuits/` does not contain integrated RiscZero dead-drop guest/host pipeline.
- No backend service in main repo for proving requests.
- `typezero-reference/` contains a complete working pattern (risc0 host/guest, backend `/prove`, selector prefixing, proof artifact normalization) that can be adapted directly.

## 3.4 Deployment/Tooling

Current state:
- Build/test scripts are functional.
- Deployment script intentionally uses `mock-verifier` and static image id for dead-drop.
- No environment contract for real verifier selector/image management.

## 3.5 Wallet/Auth

Current state:
- `useWallet` (used by app) supports dev signers only.
- `useWalletStandalone` supports Stellar Wallets Kit and has `signAuthEntry` support.
- No passkey/smart-account integration in active flow.
- `dead-drop-frontend/package.json` already includes `sac-sdk`, but it is unused.

---

## 4. Target Architecture (Implementation End State)

```
Pinger browser                Responder browser
─────────────────             ──────────────────────────────────
1. Send PING_REQUEST ──────→  2. Receive ping_x, ping_y
                              3. Run provePingNoir() [Noir + bb.js WASM]
                              4. Return proof + public_inputs
5. Receive proof ←────────────
6. Call submit_ping on Dead Drop contract
        │
        ▼
   Dead Drop Contract (Soroban)
        │  verifies public inputs schema
        │  calls UltraHonk Verifier contract
        ▼
   UltraHonk Verifier (on-chain)
        │  checks UltraHonk proof
        ▼
   Ledger state updated, "ping" event emitted
```

1. On-chain contract verifies real Noir UltraHonk proofs for each ping submission.
2. **No backend prover** — all proving runs client-side in-browser via WASM (`@aztec/bb.js`).
3. Browser-to-browser game loop uses WebRTC DataChannel + Session Push relay fallback for proof request/response.
4. Frontend wallet layer supports:
   - dev wallets (local testing)
   - standard wallet kit (Freighter etc.)
   - passkey smart accounts via `smart-account-kit`
5. Reveal phase finalizes end-state integrity.
6. Docs/runbooks provide deterministic setup + troubleshooting + demo path.

---

## 5. Implementation Workstreams and Sequence

## Workstream A (P0): Contract Hardening Before Real Proofs

Goal: make contract deterministic, safe, and proof-ready before integrating backend/UI.

Tasks:
1. Return typed proof errors instead of panic.
2. Add session existence guard in `start_game`.
3. Add point and coordinate validation (bounds + positivity).
4. Update journal schema to bind coordinate information used in proof.
5. Add contract events via `#[contractevent]`.

Code touchpoints:
- `contracts/dead-drop/src/lib.rs`
- `contracts/dead-drop/src/test.rs`

Tests to add:
- proof rejection returns `ProofVerificationFailed`
- start_game duplicate session rejected
- out-of-range coordinate rejected
- impossible distance rejected
- journal hash mismatch when coordinate fields differ

Exit criteria:
- `cargo test -p dead-drop` green with new cases.
- No panic-based proof failures on invalid seal.

## Workstream B (P0): Wire Frontend to Real Noir Proof [PARTIALLY DONE]

**Status:** Noir circuit + proving service are implemented. Frontend wiring is pending.

Goal: replace mock proof artifacts with real Noir UltraHonk proof + public inputs.

**DONE:**
- `circuits/dead_drop/` — Noir circuit verifying Poseidon2 commitment + wrapped Manhattan distance.
- `deadDropNoirService.ts` — `provePingNoir()` generates proof entirely in-browser.
- `computeCommitmentNoir()` — Poseidon2 commitment matches circuit exactly.
- Bug fix: `UltraHonkBackend` now receives `circuit.bytecode` (not full JSON object).

**Remaining tasks:**
1. Wire `DeadDropGame.tsx handleSubmitPing` to call `provePingNoir()`.
2. Pass `proof` (bytes) + `public_inputs` (6 × 32-byte BE field elements) to `deadDropService.submitPing()`.
3. Remove mock distance / `MOCK_IMAGE_ID` / dummy seal from frontend.
4. Deploy on-chain UltraHonk verifier contract and wire to dead-drop constructor.

Public inputs schema (6 × 32-byte BE field elements):
```
[session_id, turn, ping_x, ping_y, expected_commitment, expected_distance]
```

Exit criteria:
- Local frontend can generate a real proof and have it accepted by the on-chain UltraHonk verifier.

## Workstream C (P0): Deploy UltraHonk Verifier + Wire Contract

Goal: replace mock-verifier deployment with real on-chain UltraHonk verifier.

Tasks:
1. Obtain / deploy Barretenberg UltraHonk verifier contract on Testnet.
2. Update `scripts/deploy.ts` to pass real verifier address as `verifier_id` constructor arg.
3. Persist verifier contract ID into `deployment.json` and frontend runtime config.
4. Keep backward-compatible mock mode for local/dev (existing `mock-verifier`).

Code touchpoints:
- `scripts/deploy.ts`
- `scripts/setup.ts`
- frontend runtime config loader

Exit criteria:
- one documented command path for mock mode and one for real-verifier mode.
- `submit_ping` with a real Noir proof succeeds against the on-chain UltraHonk verifier.

## Workstream D (P1): Frontend Trustless Ping Flow

Goal: replace local mock computations with real prover-backed turn processing.

Tasks:
1. Add `ProofClient` service to call backend `/prove/ping`.
2. Replace `mockDistance` logic in `handleSubmitPing` with proof response.
3. Remove `MOCK_IMAGE_ID`/dummy seal usage.
4. Introduce explicit async states: `request_sent`, `proof_generating`, `submitting_tx`, `confirmed`, `failed`.
5. Improve event sync from full-window polling to incremental/cursor strategy.

Code touchpoints:
- `dead-drop-frontend/src/games/dead-drop/DeadDropGame.tsx`
- `dead-drop-frontend/src/games/dead-drop/deadDropService.ts`
- new proof client module

Exit criteria:
- pings in UI are always sourced from proof artifacts, not local simulation.

## Workstream E (P1): P2P Signaling + Auto-Responder

Goal: two-browser gameplay where responder generates proof in response to ping requests.

Tasks:
1. Add signaling layer (WebRTC offer/answer + ICE exchange).
2. Add DataChannel protocol:
- `PING_REQUEST`
- `PING_PROOF_RESPONSE`
- `ACK`/`ERROR`
3. Implement responder worker/handler to call proving backend and return artifacts.
4. Add fallback transport path (backend relay or event-based polling) when WebRTC fails.
5. Add reconnect/session resume handling.

Exit criteria:
- complete game between two separate browsers/devices without shared sessionStorage secrets.

## Workstream F (P1): Passkey + Smart Accounts (`smart-account-kit`)

Target dependency:
- `https://github.com/kalepail/smart-account-kit`

Goal: passkey-first auth + signing through smart accounts.

Tasks:
1. Introduce wallet adapter abstraction used by app-level wallet hook.
2. Implement adapters:
- `dev` (existing)
- `stellar-wallets-kit` (existing standalone logic)
- `smart-account-kit` (new passkey adapter)
3. Passkey onboarding UX:
- create account
- sign in with passkey
- session persistence/restore
4. Recovery UX:
- device change/recover account path
- clear errors when WebAuthn unavailable
5. Signing compatibility matrix:
- `signTransaction`
- `signAuthEntry`
- if non-invoker auth entry signing is unsupported, route users through single-sig lobby flow (`open_game`/`join_game`) and keep multi-sig export/import as legacy/dev-only.
6. Feature flag rollout:
- `VITE_WALLET_MODE=dev|wallet|smart-account|hybrid`
7. Security checklist:
- credential storage scope
- session timeout
- auth replay protection
- minimal smart-account permissions

Code touchpoints:
- `dead-drop-frontend/src/hooks/useWallet.ts`
- `dead-drop-frontend/src/store/walletSlice.ts`
- new wallet adapter modules
- onboarding/connect UI components

Exit criteria:
- production path can play full game with passkey-backed smart account and no dev secrets.

## Workstream G (P0): OpenZeppelin Relayer Integration

Reference:
- `https://developers.stellar.org/docs/tools/openzeppelin-relayer`

Goal: production-safe sponsored transaction submission without client-held fee-payer secrets.

Tasks:
1. Add backend relayer adapter using `@openzeppelin/relayer-plugin-channels`:
- `POST /tx/submit` accepts `func_xdr` + `auth_entries_xdr`
- calls `submitSorobanTransaction`
- polls RPC for transaction final status
2. Add frontend submission mode switch:
- `VITE_DEAD_DROP_RELAYER_URL` enables relayer path
- fallback remains direct `signAndSend` for local/dev
3. Ensure auth-entry signing remains in browser (passkey), while envelope/source signing happens in relayer.
4. Add relayer-side validation and abuse controls:
- allowed contract IDs/functions
- auth entry count/size bounds
- rate limits and request correlation IDs
5. Add env/runbook:
- `OZ_RELAYER_API_KEY`
- `OZ_RELAYER_BASE_URL`
- relayer URL propagation in setup/deploy/publish/runtime config

Code touchpoints:
- `backend/dead-drop-prover/server.js`
- `backend/dead-drop-prover/relayer.js`
- `dead-drop-frontend/src/utils/transactionHelper.ts`
- `dead-drop-frontend/src/utils/constants.ts`
- `scripts/deploy.ts`
- `scripts/setup.ts`
- `scripts/publish.ts`

Exit criteria:
- frontend gameplay actions can be submitted via relayer with no client fee-payer secret.

## Workstream H (P1): Reveal Phase

Goal: align with implementation plan’s end-game reveal and integrity guarantees.

Tasks:
1. Add `reveal_secret` and reveal state in contract.
2. Validate secret+salt against stored commitment.
3. Define winner finalization semantics for:
- distance==0 path
- max-turn path
- timeout path
4. Update frontend with reveal UI and post-game verification display.

Exit criteria:
- final winner can be cryptographically explained from reveals where required by game mode.

## Workstream I (P2): Gadgets

Goal: implement minimum viable gadget system (Sat-Link + Intercept).

Tasks:
1. Add gadget state and one-time-use mask in contract.
2. Define gadget proof statements (guest program extension or second guest).
3. Add frontend gadget inventory/activation UX.
4. Add tests for non-reuse, effect correctness, and interaction with turn order.

Exit criteria:
- both gadgets usable in full game and validated by contract rules.

## Workstream J (P2): Documentation and Demo Packaging

Tasks:
1. Rewrite `contracts/dead-drop/README.md` to match actual game.
2. Add backend/prover runbook and environment setup docs.
3. Add “mock mode vs real mode” operational guide.
4. Add E2E smoke checklist and demo script.

Exit criteria:
- new contributor can run mock mode quickly and real mode with documented prerequisites.

---

## 6. Detailed Milestone Plan

## Milestone 1: Proof-Ready Core (2-3 days)

Deliverables:
- hardened contract checks
- typed proof errors
- updated tests
- updated deploy config schema for real verifier values

Go/No-Go criteria:
- all dead-drop contract tests pass
- new negative tests for proof/pathology cases pass

## Milestone 2: Real Proof Vertical Slice (3-4 days)

Deliverables:
- dead-drop RiscZero guest + host
- backend `/prove/ping`
- frontend submits real proof artifacts

Go/No-Go criteria:
- one proof generated locally and accepted on chain end-to-end

## Milestone 3: Two-Browser Gameplay (3-4 days)

Deliverables:
- WebRTC protocol + auto-responder + fallback
- game completes between two distinct clients

Go/No-Go criteria:
- 5 repeated full-match runs complete without manual state surgery

## Milestone 4: Passkeys + Smart Accounts (2-3 days)

Deliverables:
- `smart-account-kit` adapter
- passkey onboarding and reconnect/recovery UX
- signing compatibility documented

Go/No-Go criteria:
- full match playable with passkey account in supported browser

## Milestone 5: Reveal + Docs + Demo (2-3 days)

Deliverables:
- reveal phase implementation
- updated docs and demo checklist

Go/No-Go criteria:
- deterministic finalization visible in UI and reproducible in tests

---

## 7. Test Strategy

## Contract
- Extend `contracts/dead-drop/src/test.rs` for all new validation branches.
- Add tests for reveal phase and gadget branches as introduced.

## Prover/Backend
- Host tests for deterministic journal encoding and distance edge cases.
- Backend tests for selector handling, artifact validation, and bounds checks.

## Frontend
- Component-level tests for turn transitions and proof submission error states.
- Integration tests for service methods with mocked backend responses.

## End-to-End
- Scripted scenario:
1. open lobby
2. join lobby
3. both commit
4. 3-5 turns with real proofs
5. end condition + hub end event

---

## 8. Risk Register and Mitigations

1. Proof generation latency too high
- Mitigation: queue/progress UX, optional dev receipt mode in non-production.

2. WebRTC reliability issues
- Mitigation: fallback relay/polling channel.

3. Smart-account signing incompatibilities for auth entries
- Mitigation: prefer single-sig lobby flow for production; keep multi-sig export/import path as optional.

4. Verifier integration mismatch (selector/image id)
- Mitigation: strict normalization in backend, config validation at startup, deployment preflight checks.

5. State/event drift in frontend
- Mitigation: incremental event cursors + authoritative state polling on transitions.

---

## 9. Immediate Next Implementation Steps (Actionable)

1. **Wire `submit_ping` to real Noir proof** (Workstream B):
   - Call `provePingNoir()` in `DeadDropGame.tsx handleSubmitPing`.
   - Remove mock distance / dummy seal.
2. **Deploy on-chain UltraHonk verifier** (Workstream C):
   - Deploy verifier contract on Testnet.
   - Update `scripts/deploy.ts` and `deployment.json`.
3. **Run E2E test**: real proof → `submit_ping` → on-chain verify.
4. **Deploy relay backend** (Workstream G): expose `POST /tx/submit` and proof-request routing in production.
5. **Test auto-responder E2E** (Workstream E): two separate browsers, responder proves and returns proof.
6. **Reveal phase** (Workstream H): `reveal_secret` contract method + frontend settlement UX.

---

## 10. Validation Snapshot (Current)

Last validated: 2026-02-14

- `cargo test -p dead-drop --quiet`: pass (26/26)
- `bun run build dead-drop`: pass
- `bun run build` in `dead-drop-frontend`: pass

Current warnings to account for:
- deprecated Soroban event publish usage in contract
- large frontend JS bundle (expected — bb.js WASM)
- static asset resolution warnings in Vite build (circuit JSON import)
