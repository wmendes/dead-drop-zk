# Dead Drop Next Steps

This document tracks the current implementation status and remaining work.

## Current Status Snapshot

### Phase 1: Foundation

- [x] Dead Drop Soroban contract (`open_game`, `join_game`, `commit_secret`, `submit_ping`, `force_timeout`)
- [x] Unit tests for core contract flow (`cargo test -p dead-drop` passes: 26 tests)
- [x] Deploy Dead Drop contract on Testnet (`deployment.json` contains `dead-drop` contract ID)
- [x] Basic frontend flow (wallet / lobby / create / join / commit)
- [x] Lobby system: `open_game` (single-sig, room code) + `join_game` (single-sig, triggers Game Hub)
- [x] Commit flow: Poseidon2 commitment stored on-chain

### Phase 2: ZK Proving (Noir + UltraHonk)

- [x] Noir circuit (`circuits/dead_drop/`) — verifies Poseidon2 commitment + wrapped Manhattan distance
- [x] Client-side proving via NoirJS + bb.js (WASM, no backend needed)
- [x] Commitment helper: `computeCommitmentNoir` using `@zkpassport/poseidon2`
- [x] `deadDropNoirService.ts` wires Noir + UltraHonkBackend together
- [ ] Deploy on-chain UltraHonk verifier contract on Testnet
- [ ] Wire `submit_ping` in frontend to use real proof from `deadDropNoirService`
- [ ] End-to-end test: generate proof → submit ping → verify on-chain

### Phase 3: P2P Game Loop

- [x] WebRTC peer service (`deadDropWebRtcService.ts`)
- [x] Session Push relay service (`deadDropSessionPushService.ts`)
- [x] Proof request / response protocol over WebRTC / relay
- [x] Relay backend endpoint (`POST /tx/submit`)
- [ ] Relay backend server deployed (proof request routing in production)
- [ ] Auto-responder end-to-end: opponent ping triggers proof generation → proof returned to pinger
- [ ] Full two-browser gameplay without shared `sessionStorage` secrets
- [ ] Enforce opponent coordinate privacy model in UI (no exact opponent markers during active play)

### Phase 4: UX & Polish

- [x] Sound engine (`useSoundEngine.ts`): ambient loop, ping sounds, victory/defeat stingers
- [x] Mute toggle in HUD
- [x] Ping history panel + temperature visualization
- [x] `force_timeout()` AFK protection
- [ ] Reconnection / offline / proving-failure hardening

### Phase 5: Production Readiness

- [ ] On-chain UltraHonk verifier deployed and wired to dead-drop contract
- [ ] Relay backend deployed (not just local)
- [ ] Reveal phase: `reveal_secret` contract method + frontend settlement UX
- [ ] Passkey / Smart Account integration (`smart-account-kit`)
- [ ] Remove dev fee-payer fallback in production
- [ ] Relayer allowlists + request validation
- [ ] Demo video + presentation assets
- [ ] Security model / trust assumptions doc

---

## Gaps to Address (Priority Order)

### P0: Opponent coordinate privacy UX alignment

1. Keep opponent secrets out of local runtime assumptions (except explicit debug/reveal tooling).
2. Treat opponent ping coordinates as unknown by default in `pingHistory`.
3. Render opponent activity as uncertainty overlay and zone/distance-only log rows.
4. Add in-UI copy: "Opponent coordinates are unknown by design."
5. Verify in two separate browser profiles that opponent markers never resolve to exact coordinates.

### P0: Deploy on-chain UltraHonk verifier

1. Obtain / deploy Barretenberg UltraHonk verifier contract on Testnet.
2. Update `deployment.json` and `dead-drop` constructor to point to real verifier.
3. Run full proof → `submit_ping` → on-chain verify E2E test.

### P0: Wire frontend `submit_ping` to real Noir proof

1. In `DeadDropGame.tsx` `handleSubmitPing`, call `provePingNoir()` from `deadDropNoirService.ts`.
2. Pass proof bytes + public inputs through to `deadDropService.submitPing()`.
3. Remove mock distance / dummy proof payloads.

### P0: Deploy relay backend

1. Deploy `backend/` server with `POST /tx/submit` and proof-request routing endpoints.
2. Set `VITE_DEAD_DROP_RELAYER_URL` in production env.
3. Validate relayer mode for all game actions (open, join, commit, ping, timeout).

### P1: Reveal phase

1. Add `reveal_secret` and reveal state in contract.
2. Validate secret + salt against stored commitment on-chain.
3. Add frontend reveal UX and post-game verification display.

### P1: Passkeys + Smart Accounts

Target dependency: [smart-account-kit](https://github.com/kalepail/smart-account-kit)

1. Wallet adapter abstraction in `useWallet.ts`.
2. Passkey onboarding UX (create / sign-in / recover).
3. Signing compatibility with single-sig lobby flow (`open_game` / `join_game`).

### P2: Gadgets

1. Contract: gadget state + one-time-use mask.
2. Noir circuit extension or second circuit for gadget proofs.
3. Frontend: gadget inventory + activation UX.
4. Gadgets: Sat-Link (reveal quadrant), Intercept (steal distance).

---

## Validation Notes

- `cargo test -p dead-drop --quiet`: pass (26/26)
- `bun run build dead-drop`: pass
- `bun run build` in `dead-drop-frontend`: pass (static asset resolution warnings expected — circuit WASM)
- Backend relayer endpoint: `POST /tx/submit` (requires `OZ_RELAYER_API_KEY`)
- Privacy UX acceptance: own ping markers are exact; opponent ping positions remain unknown and are shown as uncertainty overlay.
