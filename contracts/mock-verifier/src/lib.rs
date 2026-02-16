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

    /// Dev randomness verifier stub.
    ///
    /// Verifies a simple deterministic relation so callers cannot tamper with
    /// fields independently:
    ///   randomness_output == sha256(session_id || drop_commitment || signature)
    ///
    /// This is not a production VRF verifier; it is a test/dev stand-in for the
    /// Dead Drop randomness-verifier interface.
    pub fn verify_randomness(
        env: Env,
        session_id: u32,
        randomness_output: BytesN<32>,
        drop_commitment: BytesN<32>,
        randomness_signature: BytesN<64>,
    ) -> bool {
        let mut message = Bytes::from_array(&env, &session_id.to_be_bytes());
        message.append(&Bytes::from_array(&env, &drop_commitment.to_array()));
        message.append(&Bytes::from_array(&env, &randomness_signature.to_array()));

        let expected: BytesN<32> = env.crypto().sha256(&message).into();
        expected == randomness_output
    }
}
