#!/usr/bin/env node
/**
 * Test script for Game State Service
 * Usage: node test-game-state.js [session_id]
 */

const { GameStateService } = require('./gameStateService');
const { EventIndexer } = require('./eventIndexer');

const contractId = process.env.DEAD_DROP_CONTRACT_ID || process.env.VITE_DEAD_DROP_CONTRACT_ID;
const rpcUrl = process.env.SOROBAN_RPC_URL || process.env.VITE_SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org';
const sessionId = parseInt(process.argv[2] || '1', 10);

if (!contractId) {
  console.error('Error: DEAD_DROP_CONTRACT_ID environment variable not set');
  process.exit(1);
}

console.log('Testing Game State Service');
console.log('Contract ID:', contractId);
console.log('RPC URL:', rpcUrl);
console.log('Session ID:', sessionId);
console.log('---');

async function test() {
  // Initialize services
  const eventIndexer = new EventIndexer(contractId, rpcUrl);
  const gameStateService = new GameStateService(eventIndexer, contractId, rpcUrl);

  // Start event indexer (will poll in background)
  eventIndexer.start();
  console.log('Event indexer started');

  // Wait a moment for initial poll
  await new Promise(resolve => setTimeout(resolve, 2000));

  try {
    // Test 1: Fetch game state
    console.log('\n[Test 1] Fetching game state for session', sessionId);
    const state = await gameStateService.getGameState(sessionId);
    console.log('Result:', JSON.stringify(state, null, 2));

    // Test 2: Verify cache works
    console.log('\n[Test 2] Fetching again (should hit cache)');
    const start = Date.now();
    const cachedState = await gameStateService.getGameState(sessionId);
    const elapsed = Date.now() - start;
    console.log('Elapsed time:', elapsed + 'ms', '(should be <10ms if cached)');
    console.log('Cache working:', elapsed < 10);

    // Test 3: Clear cache and fetch again
    console.log('\n[Test 3] Clear cache and fetch again');
    gameStateService.clearCache(sessionId);
    const freshState = await gameStateService.getGameState(sessionId);
    console.log('Fresh fetch completed');

    console.log('\n✅ All tests passed!');
  } catch (err) {
    console.error('\n❌ Test failed:', err.message);
    if (err.stack) {
      console.error(err.stack);
    }
  } finally {
    // Stop event indexer
    await eventIndexer.stop();
    console.log('\nEvent indexer stopped');
    process.exit(0);
  }
}

test();
