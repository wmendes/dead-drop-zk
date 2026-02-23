/**
 * Phase 1 Browser Console Test Helper
 *
 * Copy-paste this into your browser console after enabling debug mode
 * to test backfill recovery without waiting for natural cursor resets.
 *
 * Prerequisites:
 * 1. localStorage.setItem('DEAD_DROP_DEBUG', 'true')
 * 2. Reload page
 * 3. Start a game with at least 1 ping submitted
 */

// Test helper functions
const Phase1TestHelper = {
  /**
   * Get the current session ID from the UI
   */
  getCurrentSessionId() {
    const sessionElement = document.querySelector('[data-session-id]');
    if (sessionElement) {
      return parseInt(sessionElement.getAttribute('data-session-id'), 10);
    }

    // Fallback: try to extract from game info modal or URL
    const infoText = document.body.innerText;
    const match = infoText.match(/Session\s+(\d+)/i);
    if (match) {
      return parseInt(match[1], 10);
    }

    console.warn('Could not auto-detect session ID. Please enter manually:');
    const manual = prompt('Enter current session ID:');
    return manual ? parseInt(manual, 10) : null;
  },

  /**
   * Force a cursor reset to trigger backfill
   * @param {number} sessionId - Current session ID
   * @param {number} ledgerOffset - How far back to set cursor (default: 50 ledgers)
   */
  async forceCursorReset(sessionId = null, ledgerOffset = 50) {
    const service = window.__deadDropService;
    if (!service) {
      console.error('❌ deadDropService not exposed. Make sure DEAD_DROP_DEBUG is enabled and page is reloaded.');
      return;
    }

    const sid = sessionId || this.getCurrentSessionId();
    if (!sid) {
      console.error('❌ Could not determine session ID');
      return;
    }

    console.info('🧪 Phase 1 Test: Forcing cursor reset...');
    console.info(`   Session ID: ${sid}`);
    console.info(`   Ledger offset: ${ledgerOffset}`);

    // Get current ledger
    const currentCursor = service.pingEventsCursorBySession.get(sid);
    console.info(`   Current cursor: ${currentCursor ?? 'not set'}`);

    if (!currentCursor) {
      console.warn('⚠️  No cursor set yet. Submit at least 1 ping first, then try again.');
      return;
    }

    // Set cursor back to force gap
    const oldCursor = currentCursor - ledgerOffset;
    service.pingEventsCursorBySession.set(sid, oldCursor);

    console.info(`   ✅ Cursor reset to: ${oldCursor}`);
    console.info(`   Expected gap size: ~${ledgerOffset} ledgers`);
    console.info('');
    console.info('⏳ Wait for next polling cycle (2.5s) or submit a new ping to trigger backfill...');
    console.info('   Watch console for backfill logs:');
    console.info('   - [DeadDropService][getPingEvents] Event gap detected');
    console.info('   - [DeadDropService][backfillMissedEvents] Attempting backfill');
    console.info('   - [DeadDropService][backfillMissedEvents] Backfill complete');
  },

  /**
   * Force a LARGE cursor reset (>100 ledgers) to test skip logic
   */
  async forceLargeGap(sessionId = null) {
    console.info('🧪 Phase 1 Test: Testing large gap handling (should skip backfill)...');
    await this.forceCursorReset(sessionId, 150);
    console.info('   Expected: "Gap too large to backfill" warning');
  },

  /**
   * Check current backfill cache state
   */
  inspectBackfillCache(sessionId = null) {
    const service = window.__deadDropService;
    if (!service) {
      console.error('❌ deadDropService not exposed');
      return;
    }

    const sid = sessionId || this.getCurrentSessionId();
    if (!sid) {
      console.error('❌ Could not determine session ID');
      return;
    }

    const cache = service.eventBackfillCache.get(sid);
    const cursor = service.pingEventsCursorBySession.get(sid);

    console.info('📊 Backfill Cache State:');
    console.info(`   Session ID: ${sid}`);
    console.info(`   Current cursor: ${cursor ?? 'not set'}`);
    console.info(`   Cache entries: ${cache ? cache.size : 0}`);

    if (cache && cache.size > 0) {
      console.info('   Cached event keys:');
      cache.forEach((key) => {
        console.info(`     - ${key}`);
      });
    }
  },

  /**
   * Clear session cache manually
   */
  clearCache(sessionId = null) {
    const service = window.__deadDropService;
    if (!service) {
      console.error('❌ deadDropService not exposed');
      return;
    }

    const sid = sessionId || this.getCurrentSessionId();
    if (!sid) {
      console.error('❌ Could not determine session ID');
      return;
    }

    console.info(`🧹 Clearing cache for session ${sid}...`);
    service.clearSessionCache(sid);
    console.info('   ✅ Cache cleared');
  },

  /**
   * Run full test suite
   */
  async runFullTest() {
    console.clear();
    console.info('🚀 Phase 1 Full Test Suite Starting...\n');

    const sessionId = this.getCurrentSessionId();
    if (!sessionId) {
      console.error('❌ Test aborted: No session ID');
      return;
    }

    console.info('Test 1: Cache Inspection');
    this.inspectBackfillCache(sessionId);
    console.info('');

    console.info('Test 2: Small Gap Backfill (50 ledgers)');
    await this.forceCursorReset(sessionId, 50);
    console.info('   ⏳ Wait 3s for polling cycle...\n');

    await new Promise(resolve => setTimeout(resolve, 3500));

    console.info('Test 3: Large Gap Skip (150 ledgers)');
    await this.forceLargeGap(sessionId);
    console.info('   ⏳ Wait 3s for polling cycle...\n');

    await new Promise(resolve => setTimeout(resolve, 3500));

    console.info('Test 4: Cache State After Tests');
    this.inspectBackfillCache(sessionId);
    console.info('');

    console.info('✅ Test suite complete. Review logs above for backfill behavior.');
  },

  /**
   * Show help
   */
  help() {
    console.info(`
╔════════════════════════════════════════════════════════════════╗
║          Phase 1 Browser Console Test Helper                 ║
╚════════════════════════════════════════════════════════════════╝

Available Commands:

  Phase1TestHelper.forceCursorReset([sessionId], [ledgerOffset])
    Force a cursor reset to trigger backfill recovery.
    Default: 50 ledger gap

  Phase1TestHelper.forceLargeGap([sessionId])
    Force a large gap (>100 ledgers) to test skip logic.

  Phase1TestHelper.inspectBackfillCache([sessionId])
    View current backfill cache state and cursor position.

  Phase1TestHelper.clearCache([sessionId])
    Manually clear session cache (cursor + backfill data).

  Phase1TestHelper.runFullTest()
    Run complete test suite automatically.

  Phase1TestHelper.help()
    Show this help message.

Quick Start:
  1. Make sure you're in an active game with 1+ ping submitted
  2. Run: Phase1TestHelper.forceCursorReset()
  3. Wait for next polling cycle or submit a ping
  4. Check console for backfill logs

Examples:
  // Force 50 ledger gap on current session
  Phase1TestHelper.forceCursorReset()

  // Force 75 ledger gap on specific session
  Phase1TestHelper.forceCursorReset(123456, 75)

  // Test large gap handling
  Phase1TestHelper.forceLargeGap()

  // Run full test suite
  Phase1TestHelper.runFullTest()
`);
  }
};

// Auto-display help
Phase1TestHelper.help();

// Expose globally
window.Phase1TestHelper = Phase1TestHelper;

console.info('✅ Phase 1 Test Helper loaded. Type Phase1TestHelper.help() for commands.');
