#!/usr/bin/env bun
// Usage: bun scripts/validate-drop-coords.ts [p1x p1y p2x p2y]
// Validates the drop-coords proof mismatch in the dead-drop game.

const GRID = 100;

function wrappedDiff(a: number, b: number): number {
  const d = Math.abs(a - b);
  return Math.min(d, GRID - d);
}

function wrappedManhattan(px: number, py: number, rx: number, ry: number): number {
  return wrappedDiff(px, rx) + wrappedDiff(py, ry);
}

const args = process.argv.slice(2);
const p1x = args[0] !== undefined ? Number(args[0]) : 42;
const p1y = args[1] !== undefined ? Number(args[1]) : 17;
const p2x = args[2] !== undefined ? Number(args[2]) : 73;
const p2y = args[3] !== undefined ? Number(args[3]) : 88;

const dropX = (p1x + p2x) % GRID;
const dropY = (p1y + p2y) % GRID;

console.log('=== Dead Drop Coordinate Validation ===\n');
console.log(`Player 1 half:    (${p1x}, ${p1y})`);
console.log(`Player 2 half:    (${p2x}, ${p2y})`);
console.log(`Combined drop D:  (${dropX}, ${dropY})\n`);

// ── What SHOULD happen (game design intent) ──────────────────────────────────
const distDropToItself = wrappedManhattan(dropX, dropY, dropX, dropY);
console.log('─── INTENDED behaviour (ping at D → win) ───────────────────────');
console.log(`  wrappedManhattan(D, D) = ${distDropToItself}  (${distDropToItself === 0 ? 'WIN ✓' : 'NOT ZERO — BUG'})`);

// ── What ACTUALLY happens today (circuit uses only B's half) ─────────────────
// Player 1 pings D; Player 2 is responder → circuit computes dist(D, B's half)
const distDropToB = wrappedManhattan(dropX, dropY, p2x, p2y);
console.log('\n─── CURRENT circuit (responder = Player 2 half) ─────────────────');
console.log(`  wrappedManhattan(D, p2) = wrappedManhattan((${dropX},${dropY}), (${p2x},${p2y}))`);
console.log(`                          = ${distDropToB}  (${distDropToB === 0 ? 'WIN ✓' : 'WARM/COLD — BUG ✗'})`);

// Analytical: approx equals wrapped(p1x, 0) + wrapped(p1y, 0)
const approx = wrappedDiff(p1x, 0) + wrappedDiff(p1y, 0);
console.log(`  (≈ wrappedDiff(p1x,0) + wrappedDiff(p1y,0) = ${approx})`);

// ── What the correct circuit needs ──────────────────────────────────────────
console.log('\n─── REQUIRED circuit fix ────────────────────────────────────────');
console.log('  Private inputs: (a.x, a.y, salt_a), (b.x, b.y, salt_b)');
console.log('  Public inputs:  commitment_a, commitment_b, ping_x, ping_y, distance');
console.log('  Assert: Poseidon2(a.x, a.y, salt_a) == commitment_a');
console.log('  Assert: Poseidon2(b.x, b.y, salt_b) == commitment_b');
console.log('  Assert: wrappedManhattan(ping, (a.x+b.x)%100, (a.y+b.y)%100) == distance');
console.log('\n  distance=0 iff ping == D  →  WIN condition correct\n');

// ── Sanity check: actual win conditions under current circuit ────────────────
console.log('─── Under current circuit, win conditions ───────────────────────');
console.log(`  P1 wins by pinging P2's exact half: (${p2x}, ${p2y})  →  dist = ${wrappedManhattan(p2x, p2y, p2x, p2y)}`);
console.log(`  P2 wins by pinging P1's exact half: (${p1x}, ${p1y})  →  dist = ${wrappedManhattan(p1x, p1y, p1x, p1y)}`);
console.log('  (This is NOT the intended game mechanic!)\n');
