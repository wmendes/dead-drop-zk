#![no_std]

use soroban_sdk::{contract, contractimpl, Bytes, BytesN, Env};

#[contract]
pub struct MockVerifier;

#[contractimpl]
impl MockVerifier {
    /// Always-accept verifier stub for development.
    /// In production, swap for the Nethermind Groth16 verifier.
    pub fn verify(_env: Env, _seal: Bytes, _image_id: BytesN<32>, _journal_hash: BytesN<32>) {
        // Always passes
    }
}
