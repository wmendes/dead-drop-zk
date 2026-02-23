// Quick script to compute Poseidon2 commitment
// For Groth16 setup, we just need any valid witness - the values don't matter
// Only the circuit structure (R1CS) is needed for trusted setup

const { poseidon2Hash } = require('@aztec/bb.js');

// Use simple test values: drop=(50,50), salt=1
const drop_x = 50n;
const drop_y = 50n;  
const drop_salt = 1n;

// Compute commitment using Poseidon2
const commitment = poseidon2Hash([drop_x, drop_y, drop_salt]);

console.log('Commitment:', '0x' + commitment.toString(16));

// Also compute for the test case values
const test_x = 42n;
const test_y = 17n;
const test_salt = 0x1111n;
const test_commitment = poseidon2Hash([test_x, test_y, test_salt]);

console.log('Test case commitment:', '0x' + test_commitment.toString(16));
