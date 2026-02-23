# Backend Migration Testing Guide

## Quick Start

### Step 1: Test Backend Standalone

```bash
# Navigate to backend
cd backend/dead-drop-prover

# Ensure environment is configured
cat > .env << EOF
DEAD_DROP_CONTRACT_ID=CDCPVLFUIRLHUQOHYR7CEPBIMVZZU7URDYWFURJPXYJREQZK5IQBG4QY
SOROBAN_RPC_URL=https://soroban-testnet.stellar.org
EOF

# Run test script
node test-game-state.js 123

# Expected output:
# - Event indexer started
# - Game state fetched (may be null if session doesn't exist)
# - Cache working: true
# - ✅ All tests passed!
```

### Step 2: Start Backend Server

```bash
# In backend/dead-drop-prover
npm run dev

# Expected console output:
# [dead-drop-prover] Event indexer started for contract: CDCP...
# [dead-drop-prover] Game state service initialized
# [dead-drop-prover] Server listening on port 8787
```

### Step 3: Test Backend Endpoint

```bash
# In another terminal, test the endpoint
curl "http://localhost:8787/game/state?session_id=123"

# Expected response:
{
  "game": null,  # or game object if session exists
  "events": [],  # ping events for this session
  "ledger": 12345678,
  "cached_at": 1234567890000
}

# Test invalid request
curl "http://localhost:8787/game/state"
# Expected: {"error":"session_id parameter required"}

# Test with active game (use real session ID from your tests)
curl "http://localhost:8787/game/state?session_id=<real_session_id>"
```

### Step 4: Start Frontend

```bash
# Navigate to frontend
cd ../../dead-drop-frontend

# Ensure backend URL is configured
grep VITE_DEAD_DROP_RELAYER_URL ../.env
# Should show: VITE_DEAD_DROP_RELAYER_URL=http://localhost:8787

# Start dev server
bun run dev
```

### Step 5: Frontend Browser Testing

1. **Open Browser DevTools**
   - Chrome/Edge: F12 → Network tab
   - Firefox: F12 → Network tab
   - Filter by "Fetch/XHR" requests

2. **Start a Game**
   - Create or join a game
   - Watch Network tab

3. **Verify Migration Success**

   **✅ Expected (New Behavior):**
   - Request: `GET http://localhost:8787/game/state?session_id=123`
   - Frequency: Every 5 seconds
   - Response: `{ game, events, ledger, cached_at }`
   - No RPC requests to Stellar (soroban-testnet.stellar.org)

   **❌ Old Behavior (Should NOT See):**
   - Direct RPC requests to soroban-testnet.stellar.org
   - Requests every 2.5 seconds
   - Separate `getContractData` calls

4. **Verify Game Plays Smoothly**
   - Make pings
   - Check turn changes happen within 5 seconds
   - Verify no "Game not found" errors
   - Check sounds play correctly

---

## Detailed Testing Scenarios

### Test 1: New Game Creation

**Steps:**
1. Click "New Game"
2. Enter session ID
3. Set point wager
4. Create game

**Expected:**
- Backend receives no requests during creation (uses direct RPC for writes)
- After creation, polling starts at `/game/state`
- Game appears in "Waiting for opponent" state

**Verify:**
```bash
# Check backend logs
tail -f backend/dead-drop-prover/server.log

# Should see:
# [GameStateService] Could not fetch game 123: ... (normal for new lobby)
# [EventIndexer] Indexed 0 events, cursor: ...
```

### Test 2: Game Join

**Steps:**
1. Player 2 joins with room code
2. Game starts

**Expected:**
- Both players start polling `/game/state` every 5s
- Backend shows single RPC poll loop (not one per player)
- Game state updates appear within 5s for both players

**Verify:**
```bash
# Monitor backend RPC calls
# Should see ~12 calls/minute regardless of player count
grep "Indexed" backend/dead-drop-prover/server.log | tail -20
```

### Test 3: Ping Submission

**Steps:**
1. Submit a ping
2. Watch for state update

**Expected:**
- Write happens via direct RPC (unchanged)
- Within 5s, `/game/state` response includes new ping event
- Turn switches to opponent
- No consistency retry errors

**Verify in browser console:**
```javascript
// Should see logs like:
// [DeadDropGame] syncFromChain: poll
// [deadDropService] getGameStateFromBackend: { game: {...}, events: [...] }
```

### Test 4: Cache Performance

**Steps:**
1. Have two browser tabs open with same game
2. Watch network requests

**Expected:**
- Both tabs poll every 5s (offset by tab open time)
- Backend cache serves most requests (check `cached_at` timestamps)
- Backend RPC calls remain at ~12/minute total

**Verify:**
```bash
# Compare request timestamps
curl "http://localhost:8787/game/state?session_id=123" | jq '.cached_at'
# Wait 1 second
curl "http://localhost:8787/game/state?session_id=123" | jq '.cached_at'
# Should be same timestamp (cache hit)

# Wait 3 seconds
curl "http://localhost:8787/game/state?session_id=123" | jq '.cached_at'
# Should be new timestamp (cache expired)
```

### Test 5: Error Handling

**Steps:**
1. Stop backend server
2. Watch frontend behavior

**Expected:**
- Frontend shows toast: "Failed to sync game state. Retrying..."
- Polling continues every 5s
- When backend restarts, game state resumes automatically
- No crashes or freezing

**Verify:**
```bash
# Stop backend
pkill -f "node.*server.js"

# Watch frontend console - should see fetch errors
# Restart backend
cd backend/dead-drop-prover && npm run dev

# Frontend should recover within 5s
```

### Test 6: Multiple Games

**Steps:**
1. Create game A (session_id=100)
2. Create game B (session_id=200)
3. Monitor backend cache

**Expected:**
- Backend caches both sessions independently
- Cache pruning removes old sessions after 60s of inactivity
- No memory leaks

**Verify:**
```bash
# Check backend logs for cache pruning
grep "Pruned" backend/dead-drop-prover/server.log

# After 60s idle:
# [GameStateService] Pruned 2 expired cache entries
```

---

## Performance Benchmarks

### Before Migration (Direct RPC)
```bash
# Simulate old behavior - direct RPC polling
for i in {1..10}; do
  time curl -X POST https://soroban-testnet.stellar.org \
    -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","id":1,"method":"getContractData",...}'
  sleep 2.5
done

# Typical response time: 200-800ms
# Total RPC calls/minute: 24 per client
```

### After Migration (Backend API)
```bash
# Test new backend endpoint
for i in {1..10}; do
  time curl "http://localhost:8787/game/state?session_id=123"
  sleep 5
done

# Typical response time:
# - Cache hit: 10-50ms
# - Cache miss: 200-800ms (RPC call)
# Total RPC calls/minute: 12 shared across all clients
```

### Load Test
```bash
# Install apache bench
brew install apache-bench  # macOS
# or: apt-get install apache2-utils  # Linux

# Test backend under load (100 requests, 10 concurrent)
ab -n 100 -c 10 "http://localhost:8787/game/state?session_id=123"

# Expected:
# - Requests/sec: >1000 (cache hits)
# - Time per request: <10ms (mean, cache hits)
# - Failed requests: 0
```

---

## Troubleshooting

### Issue: Backend 503 Error

**Symptom:**
```json
{"error":"Game state service not available"}
```

**Diagnosis:**
```bash
# Check environment variables
cd backend/dead-drop-prover
printenv | grep DEAD_DROP_CONTRACT_ID

# Check server logs
tail -50 backend/dead-drop-prover/server.log | grep -i error
```

**Fix:**
- Ensure `DEAD_DROP_CONTRACT_ID` is set in backend `.env`
- Restart backend server

### Issue: Frontend Still Polling RPC

**Symptom:**
- Network tab shows requests to `soroban-testnet.stellar.org`
- No `/game/state` requests

**Diagnosis:**
```bash
# Check frontend environment
cd dead-drop-frontend
grep VITE_DEAD_DROP_RELAYER_URL ../.env

# Check browser console for errors
# Look for: "Backend URL not configured"
```

**Fix:**
- Set `VITE_DEAD_DROP_RELAYER_URL=http://localhost:8787` in root `.env`
- Restart frontend dev server (`bun run dev`)
- Hard refresh browser (Ctrl+Shift+R)

### Issue: Game State Not Updating

**Symptom:**
- Game state frozen
- Pings submitted but no turn change

**Diagnosis:**
```bash
# Check backend event indexer
curl "http://localhost:8787/events/ping?session_id=123"

# Check backend game state
curl "http://localhost:8787/game/state?session_id=123"

# Check RPC connectivity
curl -X POST https://soroban-testnet.stellar.org \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}'
```

**Fix:**
- Verify backend is polling RPC (check logs for "Indexed N events")
- Check Stellar RPC is not down (status.stellar.org)
- Clear cache: restart backend server

### Issue: "cached_at" Timestamp Not Updating

**Symptom:**
- All responses have same `cached_at` value
- Cache never expires

**Diagnosis:**
```bash
# Check cache TTL
grep CACHE_TTL_MS backend/dead-drop-prover/gameStateService.js
# Should be: 2000 (2 seconds)

# Test cache expiration
curl "http://localhost:8787/game/state?session_id=123" | jq '.cached_at'
sleep 3
curl "http://localhost:8787/game/state?session_id=123" | jq '.cached_at'
# Timestamps should differ by ~3000ms
```

**Fix:**
- Restart backend server
- Verify system clock is correct

---

## Success Criteria Checklist

### Backend ✅
- [ ] Server starts without errors
- [ ] Event indexer logs show "Indexed N events"
- [ ] `/game/state` endpoint returns valid JSON
- [ ] Cache hits show <50ms response time
- [ ] RPC calls stay at ~12/minute

### Frontend ✅
- [ ] No RPC requests in Network tab (except writes)
- [ ] `/game/state` requests every 5 seconds
- [ ] Game state updates within 5 seconds
- [ ] No "Game not found" errors from RPC lag
- [ ] Smooth gameplay, no freezing or blinking

### Integration ✅
- [ ] Full game playable start to finish
- [ ] Both players see updates in sync
- [ ] Sounds play at correct times
- [ ] Game over modal appears correctly
- [ ] No console errors

---

## Monitoring in Production

### Backend Metrics to Track

```bash
# RPC call frequency (should be ~12/min)
grep "Indexed" logs/backend.log | wc -l

# Cache hit rate (check response times)
grep "Game state fetch" logs/backend.log | awk '{print $NF}'

# Error rate
grep ERROR logs/backend.log | wc -l

# Memory usage (check for leaks)
ps aux | grep "node.*server.js" | awk '{print $6}'
```

### Frontend Metrics to Track

```javascript
// In browser console
// Check polling interval
const timestamps = [];
const observer = new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    if (entry.name.includes('/game/state')) {
      timestamps.push(entry.startTime);
      if (timestamps.length > 1) {
        const interval = timestamps[timestamps.length - 1] - timestamps[timestamps.length - 2];
        console.log('Poll interval:', interval, 'ms (should be ~5000)');
      }
    }
  }
});
observer.observe({ entryTypes: ['resource'] });
```

### Alerts to Configure

1. **Backend down:** `/health` endpoint non-responsive
2. **High error rate:** >5% of `/game/state` requests fail
3. **Slow responses:** Cache miss response time >2s
4. **Memory leak:** Backend process memory >500MB
5. **RPC throttling:** >20 RPC calls/minute (indicates cache issue)

---

## Next Steps After Validation

Once all tests pass:

1. **Deploy to Production**
   - Update backend environment variables
   - Set frontend `VITE_DEAD_DROP_RELAYER_URL` to production backend
   - Monitor for 24 hours

2. **Clean Up Code**
   - Remove deprecated `getGame()` method
   - Remove old consistency retry logic
   - Remove unused imports

3. **Update Documentation**
   - Update CLAUDE.md with new architecture
   - Document backend API endpoints
   - Add monitoring runbook

4. **Consider Phase 4: WebSocket Migration**
   - If 5s polling still feels slow
   - See plan document for implementation
   - Estimated 80% further load reduction
