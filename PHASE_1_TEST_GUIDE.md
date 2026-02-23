# Phase 1 Testing Guide

**Goal:** Verify event backfill recovery prevents event loss during cursor resets.

---

## Test Environment Setup

### 1. Enable Debug Mode

Open browser console and run:
```javascript
localStorage.setItem('DEAD_DROP_DEBUG', 'true')
location.reload()
```

### 2. Open Network Tab
- Chrome/Edge: F12 → Network tab
- Filter by "getEvents" to monitor RPC calls

### 3. Open Console Tab
- Monitor for `[DeadDropService]` logs

---

## Test Scenarios

### ✅ Test 1: Normal Operation (Baseline)

**Purpose:** Verify no regression in normal gameplay.

**Steps:**
1. Start the Dead Drop frontend: `cd dead-drop-frontend && bun run dev`
2. Create a new lobby
3. Join from another wallet (or wait for opponent)
4. Submit 3-5 pings normally
5. Check "Mission Log" history modal

**Expected Results:**
- ✅ All pings appear in history
- ✅ No duplicate entries
- ✅ Console shows standard polling logs
- ✅ No backfill logs (no cursor reset occurred)

**Console Output (Normal):**
```
[DeadDropService][getPingEvents] // Regular polling, no special logs
```

---

### ✅ Test 2: Forced Cursor Reset (Backfill Trigger)

**Purpose:** Verify backfill recovers events from cursor reset gap.

**Steps:**
1. Start a game and submit 2-3 pings
2. **Wait 5-8 minutes** (allows RPC ledger window to advance)
   - Alternative: Manually advance cursor in dev tools (see Advanced Testing)
3. Submit another ping
4. Check console for backfill logs
5. Verify ping history shows all pings (no gaps)

**Expected Results:**
- ✅ Console shows "Event gap detected"
- ✅ Console shows "Backfill complete" with recovered event count
- ✅ No missing pings in history
- ✅ No duplicate pings

**Console Output (Cursor Reset):**
```
[DeadDropService][getPingEvents] Event gap detected (cursor reset) {
  sessionId: 123456,
  requestedStartLedger: 50000,
  oldCursor: 49500,
  rangeMin: 49600,
  rangeMax: 50100,
  gapSize: 100,
  willBackfill: true
}

[DeadDropService][backfillMissedEvents] Attempting backfill {
  sessionId: 123456,
  fromLedger: 49500,
  toLedger: 49600,
  gapSize: 100
}

[DeadDropService][backfillMissedEvents] Backfill complete {
  sessionId: 123456,
  recoveredEvents: 2,
  gapSize: 100
}

[DeadDropService][getPingEvents] Backfilled events merged {
  sessionId: 123456,
  backfilledCount: 2,
  totalParsed: 5
}
```

---

### ✅ Test 3: Rapid Ping Submissions (Deduplication)

**Purpose:** Verify deduplication prevents duplicate events.

**Steps:**
1. Start a game
2. Submit 5 pings rapidly (one per turn)
3. Check ping history for duplicates
4. Check console for deduplication cache logs

**Expected Results:**
- ✅ Each ping appears exactly once
- ✅ No duplicate entries in history
- ✅ txHash-based deduplication working

---

### ✅ Test 4: Session Cache Cleanup

**Purpose:** Verify cache clears on new game.

**Steps:**
1. Complete a full game (game over state)
2. Click "New Game"
3. Check console for cache cleanup log
4. Start new game and verify fresh state

**Expected Results:**
- ✅ Console shows `[DeadDropService][clearSessionCache]`
- ✅ New game starts with empty history
- ✅ New session ID generated

**Note:** Currently `clearSessionCache()` is not called automatically. This will be integrated in Phase 2.

**Manual Test (Console):**
```javascript
// Get deadDropService instance (after game loads)
const service = window.__deadDropService; // We'll need to expose this

// Manually clear cache
service.clearSessionCache(123456); // Use current sessionId

// Expected console output:
// [DeadDropService][clearSessionCache] Cleared cache { sessionId: 123456 }
```

---

### ✅ Test 5: Large Gap (Backfill Skipped)

**Purpose:** Verify graceful handling when gap exceeds 100 ledgers.

**Steps:**
1. Start a game
2. Submit 1 ping
3. **Wait 15+ minutes** (gap > 100 ledgers)
4. Submit another ping
5. Check console for "Gap too large" warning

**Expected Results:**
- ✅ Console shows "willBackfill: false"
- ✅ Console shows "Gap too large to backfill"
- ✅ Game continues normally (no crash)
- ✅ Only recent events shown (backfill skipped)

**Console Output (Large Gap):**
```
[DeadDropService][getPingEvents] Event gap detected (cursor reset) {
  sessionId: 123456,
  gapSize: 150,
  willBackfill: false
}

[DeadDropService][backfillMissedEvents] Gap too large to backfill {
  sessionId: 123456,
  gapSize: 150,
  maxAllowed: 100
}
```

---

## Advanced Testing

### Manual Cursor Reset Simulation

If you don't want to wait 5-8 minutes, you can manually trigger a cursor reset:

**Option 1: Dev Tools Injection**

Open console and run:
```javascript
// Access the deadDropService instance
// (You'll need to temporarily expose it for testing)

// Manually set old cursor to force gap
const sessionId = 123456; // Use your actual session ID
const service = window.__deadDropService;

// Set cursor far in the past
service.pingEventsCursorBySession.set(sessionId, 1000);

// Next getPingEvents() call will detect gap and trigger backfill
```

**Option 2: Mock RPC Response**

Create a test file that mocks the RPC server to return out-of-range errors:

```typescript
// test-cursor-reset.ts
import { DeadDropService } from './deadDropService';

// Mock server that returns ledger range error
const mockServer = {
  getEvents: () => {
    throw new Error('startLedger must be within the ledger range: 50000 - 50500');
  }
};

// Test backfill logic
// ... (implementation details)
```

---

## Exposing Service for Testing

To test manually from console, temporarily expose the service instance:

**File:** `dead-drop-frontend/src/games/dead-drop/DeadDropGame.tsx`

Add after `const deadDropService = new DeadDropService(...)` (line 79):

```typescript
// TEMPORARY: Expose for testing
if (import.meta.env.DEV) {
  (window as any).__deadDropService = deadDropService;
}
```

Then reload and you can access it from console:
```javascript
window.__deadDropService.clearSessionCache(sessionId)
```

**Remember to remove this after testing!**

---

## Verification Checklist

After running all tests:

- [ ] **Test 1 (Baseline):** Normal gameplay works, no regressions
- [ ] **Test 2 (Cursor Reset):** Backfill recovers events from gaps
- [ ] **Test 3 (Deduplication):** No duplicate pings in history
- [ ] **Test 4 (Cache Cleanup):** clearSessionCache() logs appear
- [ ] **Test 5 (Large Gap):** Graceful handling when gap too large
- [ ] **Network Tab:** No new RPC errors introduced
- [ ] **Console:** No JavaScript errors or warnings
- [ ] **Ping History:** All pings appear correctly ordered
- [ ] **Performance:** No noticeable lag during backfill

---

## Success Criteria

Phase 1 passes testing if:

✅ **Zero Event Loss:** All pings appear in history (even after cursor reset)
✅ **Zero Duplicates:** Each ping appears exactly once
✅ **No Errors:** No console errors or RPC failures
✅ **Backward Compatible:** Existing gameplay unchanged
✅ **Debug Logging:** Clear visibility into backfill operations

---

## Troubleshooting

### Issue: No backfill logs appear

**Possible causes:**
- Debug mode not enabled (`localStorage.setItem('DEAD_DROP_DEBUG', 'true')`)
- Cursor reset didn't occur (gap too small or RPC window didn't advance)
- Network issues preventing RPC calls

**Solution:**
- Verify debug mode: `localStorage.getItem('DEAD_DROP_DEBUG')`
- Wait longer between pings (8-10 minutes)
- Check Network tab for RPC errors

### Issue: Duplicate pings in history

**Possible causes:**
- Deduplication cache not working
- Multiple rapid polling cycles
- Cache cleared prematurely

**Solution:**
- Check console for backfill cache logs
- Verify `eventBackfillCache` is persisted across polls
- Report for investigation

### Issue: "Gap too large" warning but events still missing

**Expected behavior:**
- Gaps >100 ledgers skip backfill (by design)
- Only recent events shown

**This is not a bug** - it's the intended trade-off to prevent RPC overload.

---

## Reporting Results

After testing, report findings:

**Format:**
```
## Phase 1 Test Results

**Test Environment:**
- Browser: Chrome/Firefox/Safari
- Network: Testnet
- Session ID: [your session ID]

**Test 1 (Baseline):** ✅ PASS / ❌ FAIL
- Notes: [any observations]

**Test 2 (Cursor Reset):** ✅ PASS / ❌ FAIL
- Gap size: X ledgers
- Events recovered: X
- Notes: [any observations]

**Test 3 (Deduplication):** ✅ PASS / ❌ FAIL
- Total pings: X
- Duplicates found: X
- Notes: [any observations]

**Test 4 (Cache Cleanup):** ✅ PASS / ❌ FAIL
- Notes: [any observations]

**Test 5 (Large Gap):** ✅ PASS / ❌ FAIL
- Gap size: X ledgers
- Notes: [any observations]

**Overall:** ✅ PASS / ❌ FAIL
```

---

## Next Steps After Testing

### If All Tests Pass ✅
- Commit Phase 1 changes
- Proceed to Phase 2 (State Machine Refactor)

### If Issues Found ❌
- Document specific failures
- Review implementation
- Fix bugs before proceeding

### Performance Monitoring
- Monitor RPC call frequency (should not increase significantly)
- Check memory usage with backfill cache
- Verify no UI lag during backfill
