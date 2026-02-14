#![no_std]

use soroban_sdk::{contract, contractimpl, Bytes, BytesN, Env, Vec};

#[contract]
pub struct MockVerifier;

#[contractimpl]
impl MockVerifier {
    /// Always-accept verifier stub for development.
    /// Matches the UltraHonk verifier interface:
    ///   verify_proof(proof: Bytes, public_inputs: Vec<BytesN<32>>)
    ///
    /// In production, deploy the real UltraHonk verifier
    /// (indextree/ultrahonk_soroban_contract) and point to its address.
    pub fn verify_proof(
        _env: Env,
        _proof: Bytes,
        _public_inputs: Vec<BytesN<32>>,
    ) {
        // Always passes — accepts any proof during development
    }
}
