# Dead Drop Next Steps

This document compares the current codebase against the implementation plan in `Game Project Feasibility Whitepaper.md` (Section 10, "Implementation Plan (14 Days)").

## Current Status Snapshot

### Phase 1: Foundation (Days 1-3)

- [x] Fork TypeZero-style project structure as boilerplate
- [x] Dead Drop Soroban contract implemented (`open_game`, `join_game`, `commit_secret`, `submit_ping`, `force_timeout`)
- [x] Unit tests for core contract flow (`cargo test -p dead-drop` passes: 21 tests)
- [ ] Deploy Nethermind Groth16 verifier on Testnet (currently using `mock-verifier`)
- [x] Deploy Dead Drop contract on Testnet (`deployment.json` contains `dead-drop` contract ID)
- [x] Basic frontend flow (wallet/lobby/create/join/commit)

### Phase 2: ZK Proving (Days 4-7)

- [ ] RiscZero dev environment and project wiring
- [ ] Ping Guest Program (distance + commitment verification)
- [ ] RiscZero Host proving pipeline
- [ ] Backend proving service adapted for Dead Drop inputs
- [ ] End-to-end real proof generation + on-chain verification
- [ ] `VERIFIER_SELECTOR_HEX` handling per TypeZero pattern

Notes:
- Frontend currently submits mock proof payloads (`MOCK_IMAGE_ID` + dummy `seal`) and mock/computed distances.
- Contract verification path exists, but deployment is wired to `mock-verifier`.

### Phase 3: P2P & Game Loop (Days 8-10)

- [ ] WebRTC signaling + DataChannel between browsers
- [ ] Auto-responder worker (receive query -> call proving service -> return response)
- [ ] Full trustless turn loop with real off-chain responder proofs
- [x] Ping history panel + temperature visualization
- [ ] Reveal phase (secret reveal + final winner logic tied to reveal)
- [x] `force_timeout()` AFK protection

### Phase 4: Gadgets & Polish (Days 11-12)

- [ ] Gadget Guest Program
- [ ] Gadget UI/inventory and activation flow
- [ ] Sat-Link gadget
- [ ] Intercept gadget
- [ ] `gadget_usage_mask` contract support
- [~] Sound/visual polish (good progress in current frontend)
- [ ] Reconnection/offline/proving-failure hardening

### Phase 5: Demo & Documentation (Days 13-14)

- [ ] End-to-end testnet scenarios (with real proofs, not mock verifier)
- [ ] Demo video
- [ ] Dead Drop-specific README and setup instructions (current `contracts/dead-drop/README.md` is outdated and describes number-guess behavior)
- [ ] Presentation assets
- [ ] Security model / trust assumptions doc for final demo package

## Gaps to Address First (Priority Order)

## P0: Replace mock ZK path with real proving + verifier

1. Add a real proving stack (guest + host + service) for ping proofs.
2. Deploy/configure Nethermind Groth16 verifier and wire real `image_id`.
3. Update frontend `submit_ping` path to request real proof artifacts (distance/journal/seal) from responder/proving service.
4. Add integration test: generate proof -> submit ping -> verify success on-chain.

## P1: Implement real 2-player off-chain protocol

1. Add WebRTC signaling and a resilient fallback transport.
2. Build auto-responder flow to handle opponent ping requests while user is in-session.
3. Remove local/mock opponent-secret dependence from frontend gameplay loop.

## P1: Add explicit reveal phase

1. Define reveal methods and state transitions in contract.
2. Add frontend reveal UX and settlement logic.
3. Ensure Game Hub `end_game` is called once in final path.

## P2: Gadgets

1. Add contract data model for gadget usage and one-time constraints.
2. Implement gadget proof/program path.
3. Add UI + telemetry for gadget actions.

## P2: Ship-readiness and docs

1. Replace outdated Dead Drop contract README.
2. Add runbook: local/dev/testnet setup, proving latency expectations, failure handling.
3. Add end-to-end regression checklist and scripted smoke tests.

## P1: Passkeys + Smart Accounts Integration

Target dependency: [smart-account-kit](https://github.com/kalepail/smart-account-kit)

1. Integrate `smart-account-kit` in `dead-drop-frontend` for passkey-based account creation/sign-in.
2. Add smart account session bootstrapping and account recovery flow to onboarding.
3. Replace or adapt current wallet signing hooks (`/Users/wlademyr/Code/hackathon-zk-wlad/dead-drop-frontend/src/hooks/useWallet.ts`) to route contract auth + tx signing through smart accounts.
4. Validate multisig/start-game flow compatibility (auth entry export/import and finalization) with passkey-backed smart accounts.
5. Add fallback UX for unsupported browsers/devices and migration path for existing dev wallets.
6. Add security review checklist for passkey credential handling and account abstraction permissions.

## Validation Notes

- `cargo test -p dead-drop --quiet`: pass (21/21)
- `bun run build dead-drop`: pass
- `bun run build` in `dead-drop-frontend`: pass (with static asset resolution warnings)
