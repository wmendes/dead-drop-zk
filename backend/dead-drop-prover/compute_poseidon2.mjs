import { BarretenbergSync } from '@aztec/bb.js';

const api = await BarretenbergSync.initSingleton();

// Test values: drop=(42,17), salt=0x1111
const inputs = [42n, 17n, 0x1111n];

// Compute Poseidon2 hash (sponge with 3 inputs)
const commitment = api.poseidon2Hash(inputs);

console.log('Commitment (hex):', '0x' + commitment.toString(16));
console.log('Commitment (dec):', commitment.toString());

// Also compute for drop=(50,50), salt=1
const inputs2 = [50n, 50n, 1n];
const commitment2 = api.poseidon2Hash(inputs2);
console.log('\nAlternative (50,50,1):');
console.log('Commitment (hex):', '0x' + commitment2.toString(16));

process.exit(0);
