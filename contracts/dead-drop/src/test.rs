#![cfg(test)]

use crate::{DeadDropContract, DeadDropContractClient, Error, GameStatus};
use soroban_sdk::testutils::{Address as _, Ledger as _};
use soroban_sdk::{contract, contractimpl, Address, Bytes, BytesN, Env, Vec};

// ============================================================================
// Mock Contracts
// ============================================================================

#[contract]
pub struct MockGameHub;

#[contractimpl]
impl MockGameHub {
    pub fn start_game(
        _env: Env,
        _game_id: Address,
        _session_id: u32,
        _player1: Address,
        _player2: Address,
        _player1_points: i128,
        _player2_points: i128,
    ) {
    }

    pub fn end_game(_env: Env, _session_id: u32, _player1_won: bool) {}
}

#[contract]
pub struct MockVerifier;

#[contractimpl]
impl MockVerifier {
    pub fn verify_proof(_env: Env, _proof: Bytes, _public_inputs: Vec<BytesN<32>>) {}
}

#[contract]
pub struct RejectVerifier;

#[contractimpl]
impl RejectVerifier {
    pub fn verify_proof(_env: Env, _proof: Bytes, _public_inputs: Vec<BytesN<32>>) {
        panic!("proof rejected");
    }
}

#[contract]
pub struct MockRandomnessVerifier;

#[contractimpl]
impl MockRandomnessVerifier {
    pub fn verify_randomness(
        env: Env,
        session_id: u32,
        randomness_output: BytesN<32>,
        drop_commitment: BytesN<32>,
        randomness_signature: BytesN<64>,
    ) -> bool {
        let expected = build_randomness_output(
            &env,
            session_id,
            &drop_commitment,
            &randomness_signature,
        );
        expected == randomness_output
    }
}

#[contract]
pub struct RejectRandomnessVerifier;

#[contractimpl]
impl RejectRandomnessVerifier {
    pub fn verify_randomness(
        _env: Env,
        _session_id: u32,
        _randomness_output: BytesN<32>,
        _drop_commitment: BytesN<32>,
        _randomness_signature: BytesN<64>,
    ) -> bool {
        false
    }
}

// ============================================================================
// Helpers
// ============================================================================

fn setup_test() -> (
    Env,
    DeadDropContractClient<'static>,
    Address,
    Address,
) {
    let env = Env::default();
    env.mock_all_auths();

    env.ledger().set(soroban_sdk::testutils::LedgerInfo {
        timestamp: 1_441_065_600,
        protocol_version: 25,
        sequence_number: 100,
        network_id: Default::default(),
        base_reserve: 10,
        min_temp_entry_ttl: u32::MAX / 2,
        min_persistent_entry_ttl: u32::MAX / 2,
        max_entry_ttl: u32::MAX / 2,
    });

    let hub_addr = env.register(MockGameHub, ());
    let verifier_addr = env.register(MockVerifier, ());
    let randomness_verifier_addr = env.register(MockRandomnessVerifier, ());
    let admin = Address::generate(&env);

    let contract_id = env.register(
        DeadDropContract,
        (&admin, &hub_addr, &verifier_addr, &randomness_verifier_addr),
    );
    let client = DeadDropContractClient::new(&env, &contract_id);

    let player1 = Address::generate(&env);
    let player2 = Address::generate(&env);

    (env, client, player1, player2)
}

fn assert_dead_drop_error<T, E>(
    result: &Result<Result<T, E>, Result<Error, soroban_sdk::InvokeError>>,
    expected_error: Error,
) {
    match result {
        Err(Ok(actual_error)) => {
            assert_eq!(
                *actual_error, expected_error,
                "Expected error {:?}, got {:?}",
                expected_error, actual_error
            );
        }
        Err(Err(_)) => panic!(
            "Expected contract error {:?}, got invocation error",
            expected_error
        ),
        Ok(Err(_)) => panic!(
            "Expected contract error {:?}, got conversion error",
            expected_error
        ),
        Ok(Ok(_)) => panic!("Expected error {:?}, but operation succeeded", expected_error),
    }
}

fn make_drop_commitment(env: &Env, salt: &[u8; 32]) -> BytesN<32> {
    let bytes = Bytes::from_array(env, salt);
    env.crypto().sha256(&bytes).into()
}

fn build_randomness_output(
    env: &Env,
    session_id: u32,
    drop_commitment: &BytesN<32>,
    randomness_signature: &BytesN<64>,
) -> BytesN<32> {
    let mut message = Bytes::from_array(env, &session_id.to_be_bytes());
    message.append(&Bytes::from_array(env, &drop_commitment.to_array()));
    message.append(&Bytes::from_array(env, &randomness_signature.to_array()));
    env.crypto().sha256(&message).into()
}

fn make_randomness_artifacts(
    env: &Env,
    session_id: u32,
    drop_commitment: &BytesN<32>,
) -> (BytesN<32>, BytesN<64>) {
    let mut sig = [0u8; 64];
    sig[0..4].copy_from_slice(&session_id.to_be_bytes());
    sig[4..8].copy_from_slice(&(!session_id).to_be_bytes());
    let signature = BytesN::from_array(env, &sig);
    let output = build_randomness_output(env, session_id, drop_commitment, &signature);
    (output, signature)
}

fn u32_to_field_bytes(env: &Env, value: u32) -> BytesN<32> {
    let mut buf = [0u8; 32];
    buf[28..32].copy_from_slice(&value.to_be_bytes());
    BytesN::from_array(env, &buf)
}

fn make_public_inputs(
    env: &Env,
    session_id: u32,
    turn: u32,
    ping_x: u32,
    ping_y: u32,
    drop_commitment: &BytesN<32>,
    distance: u32,
) -> Vec<BytesN<32>> {
    let mut inputs = Vec::new(env);
    inputs.push_back(u32_to_field_bytes(env, session_id));
    inputs.push_back(u32_to_field_bytes(env, turn));
    inputs.push_back(u32_to_field_bytes(env, ping_x));
    inputs.push_back(u32_to_field_bytes(env, ping_y));
    inputs.push_back(drop_commitment.clone());
    inputs.push_back(u32_to_field_bytes(env, distance));
    inputs
}

// ============================================================================
// Tests
// ============================================================================

#[test]
fn test_start_game() {
    let (env, client, player1, player2) = setup_test();
    let session_id = 1u32;
    let points = 100_0000000i128;
    let drop_commitment = make_drop_commitment(&env, &[11u8; 32]);
    let (randomness_output, randomness_signature) =
        make_randomness_artifacts(&env, session_id, &drop_commitment);

    client.start_game(
        &session_id,
        &player1,
        &player2,
        &points,
        &points,
        &randomness_output,
        &drop_commitment,
        &randomness_signature,
    );

    let game = client.get_game(&session_id);
    assert_eq!(game.player1, player1);
    assert_eq!(game.player2, player2);
    assert_eq!(game.player1_points, points);
    assert_eq!(game.player2_points, points);
    assert_eq!(game.status, GameStatus::Active);
    assert_eq!(game.current_turn, 0);
    assert_eq!(game.drop_commitment, drop_commitment);
    assert!(game.winner.is_none());
}

#[test]
fn test_start_game_randomness_verification_failed() {
    let (env, client, player1, player2) = setup_test();
    let session_id = 2u32;
    let drop_commitment = make_drop_commitment(&env, &[1u8; 32]);
    let (_randomness_output, randomness_signature) =
        make_randomness_artifacts(&env, session_id, &drop_commitment);
    let bad_output = BytesN::from_array(&env, &[9u8; 32]);

    let result = client.try_start_game(
        &session_id,
        &player1,
        &player2,
        &100_0000000,
        &100_0000000,
        &bad_output,
        &drop_commitment,
        &randomness_signature,
    );
    assert_dead_drop_error(&result, Error::RandomnessVerificationFailed);
}

#[test]
fn test_self_play_rejected() {
    let (env, client, player1, _player2) = setup_test();
    let session_id = 3u32;
    let drop_commitment = make_drop_commitment(&env, &[2u8; 32]);
    let (randomness_output, randomness_signature) =
        make_randomness_artifacts(&env, session_id, &drop_commitment);

    let same = player1.clone();
    let result = client.try_start_game(
        &session_id,
        &player1,
        &same,
        &100_0000000,
        &100_0000000,
        &randomness_output,
        &drop_commitment,
        &randomness_signature,
    );
    assert_dead_drop_error(&result, Error::SelfPlay);
}

#[test]
fn test_open_and_join_game() {
    let (env, client, player1, player2) = setup_test();
    let session_id = 100u32;
    let points = 100_0000000i128;

    client.open_game(&session_id, &player1, &points);

    let lobby = client.get_lobby(&session_id);
    assert_eq!(lobby.host, player1);
    assert_eq!(lobby.host_points, points);

    let drop_commitment = make_drop_commitment(&env, &[7u8; 32]);
    let (randomness_output, randomness_signature) =
        make_randomness_artifacts(&env, session_id, &drop_commitment);

    client.join_game(
        &session_id,
        &player2,
        &points,
        &randomness_output,
        &drop_commitment,
        &randomness_signature,
    );

    let result = client.try_get_lobby(&session_id);
    assert_dead_drop_error(&result, Error::LobbyNotFound);

    let game = client.get_game(&session_id);
    assert_eq!(game.player1, player1);
    assert_eq!(game.player2, player2);
    assert_eq!(game.status, GameStatus::Active);
    assert_eq!(game.drop_commitment, drop_commitment);
}

#[test]
fn test_join_game_randomness_rejected() {
    let (env, client, player1, player2) = setup_test();
    let session_id = 101u32;
    let points = 100_0000000i128;

    client.open_game(&session_id, &player1, &points);

    let drop_commitment = make_drop_commitment(&env, &[8u8; 32]);
    let (_output, randomness_signature) =
        make_randomness_artifacts(&env, session_id, &drop_commitment);
    let bad_output = BytesN::from_array(&env, &[3u8; 32]);

    let result = client.try_join_game(
        &session_id,
        &player2,
        &points,
        &bad_output,
        &drop_commitment,
        &randomness_signature,
    );
    assert_dead_drop_error(&result, Error::RandomnessVerificationFailed);
}

#[test]
fn test_submit_ping() {
    let (env, client, player1, player2) = setup_test();
    let session_id = 5u32;
    let points = 100_0000000i128;
    let drop_commitment = make_drop_commitment(&env, &[4u8; 32]);
    let (randomness_output, randomness_signature) =
        make_randomness_artifacts(&env, session_id, &drop_commitment);

    client.start_game(
        &session_id,
        &player1,
        &player2,
        &points,
        &points,
        &randomness_output,
        &drop_commitment,
        &randomness_signature,
    );

    let distance = 25u32;
    let public_inputs = make_public_inputs(&env, session_id, 0, 50u32, 60u32, &drop_commitment, distance);
    let proof = Bytes::from_slice(&env, &[1, 2, 3]);

    let result = client.submit_ping(
        &session_id,
        &player1,
        &0u32,
        &distance,
        &50u32,
        &60u32,
        &proof,
        &public_inputs,
    );
    assert!(result.is_none());

    let game = client.get_game(&session_id);
    assert_eq!(game.current_turn, 1);
    assert_eq!(game.whose_turn, 2);
    assert_eq!(game.player1_best_distance, 25);
}

#[test]
fn test_wrong_turn_rejected() {
    let (env, client, player1, player2) = setup_test();
    let session_id = 6u32;
    let drop_commitment = make_drop_commitment(&env, &[5u8; 32]);
    let (randomness_output, randomness_signature) =
        make_randomness_artifacts(&env, session_id, &drop_commitment);

    client.start_game(
        &session_id,
        &player1,
        &player2,
        &100_0000000,
        &100_0000000,
        &randomness_output,
        &drop_commitment,
        &randomness_signature,
    );

    let public_inputs = make_public_inputs(&env, session_id, 0, 0u32, 0u32, &drop_commitment, 10);
    let proof = Bytes::from_slice(&env, &[1, 2, 3]);

    let result = client.try_submit_ping(
        &session_id,
        &player2,
        &0u32,
        &10u32,
        &0u32,
        &0u32,
        &proof,
        &public_inputs,
    );
    assert_dead_drop_error(&result, Error::NotYourTurn);
}

#[test]
fn test_distance_zero_wins() {
    let (env, client, player1, player2) = setup_test();
    let session_id = 7u32;
    let points = 100_0000000i128;
    let drop_commitment = make_drop_commitment(&env, &[6u8; 32]);
    let (randomness_output, randomness_signature) =
        make_randomness_artifacts(&env, session_id, &drop_commitment);

    client.start_game(
        &session_id,
        &player1,
        &player2,
        &points,
        &points,
        &randomness_output,
        &drop_commitment,
        &randomness_signature,
    );

    let public_inputs = make_public_inputs(&env, session_id, 0, 20u32, 30u32, &drop_commitment, 0);
    let proof = Bytes::from_slice(&env, &[1, 2, 3]);

    let result = client.submit_ping(
        &session_id,
        &player1,
        &0u32,
        &0u32,
        &20u32,
        &30u32,
        &proof,
        &public_inputs,
    );
    assert!(result.is_some());
    assert_eq!(result.unwrap(), player1);

    let game = client.get_game(&session_id);
    assert_eq!(game.status, GameStatus::Completed);
    assert_eq!(game.winner, Some(player1));
}

#[test]
fn test_30_turns_closest_wins() {
    let (env, client, player1, player2) = setup_test();
    let session_id = 8u32;
    let points = 100_0000000i128;
    let drop_commitment = make_drop_commitment(&env, &[9u8; 32]);
    let (randomness_output, randomness_signature) =
        make_randomness_artifacts(&env, session_id, &drop_commitment);

    client.start_game(
        &session_id,
        &player1,
        &player2,
        &points,
        &points,
        &randomness_output,
        &drop_commitment,
        &randomness_signature,
    );

    let proof = Bytes::from_slice(&env, &[1, 2, 3]);

    for turn in 0u32..30 {
        let is_p1_turn = turn % 2 == 0;
        if is_p1_turn {
            let distance = 5u32;
            let public_inputs = make_public_inputs(&env, session_id, turn, 11u32, 22u32, &drop_commitment, distance);
            let result = client.submit_ping(
                &session_id,
                &player1,
                &turn,
                &distance,
                &11u32,
                &22u32,
                &proof,
                &public_inputs,
            );
            if turn < 28 {
                assert!(result.is_none());
            }
        } else {
            let distance = 10u32;
            let public_inputs = make_public_inputs(&env, session_id, turn, 33u32, 44u32, &drop_commitment, distance);
            let result = client.submit_ping(
                &session_id,
                &player2,
                &turn,
                &distance,
                &33u32,
                &44u32,
                &proof,
                &public_inputs,
            );
            if turn == 29 {
                assert!(result.is_some());
                assert_eq!(result.unwrap(), player1);
            } else {
                assert!(result.is_none());
            }
        }
    }

    let game = client.get_game(&session_id);
    assert_eq!(game.status, GameStatus::Completed);
    assert_eq!(game.winner, Some(player1));
    assert_eq!(game.player1_best_distance, 5);
    assert_eq!(game.player2_best_distance, 10);
}

#[test]
fn test_force_timeout() {
    let (env, client, player1, player2) = setup_test();
    let session_id = 9u32;
    let drop_commitment = make_drop_commitment(&env, &[10u8; 32]);
    let (randomness_output, randomness_signature) =
        make_randomness_artifacts(&env, session_id, &drop_commitment);

    client.start_game(
        &session_id,
        &player1,
        &player2,
        &100_0000000,
        &100_0000000,
        &randomness_output,
        &drop_commitment,
        &randomness_signature,
    );

    let result = client.try_force_timeout(&session_id, &player1);
    assert_dead_drop_error(&result, Error::TimeoutNotReached);

    env.ledger().set(soroban_sdk::testutils::LedgerInfo {
        timestamp: 1_441_065_600 + 4000,
        protocol_version: 25,
        sequence_number: 100 + 700,
        network_id: Default::default(),
        base_reserve: 10,
        min_temp_entry_ttl: u32::MAX / 2,
        min_persistent_entry_ttl: u32::MAX / 2,
        max_entry_ttl: u32::MAX / 2,
    });

    let winner = client.force_timeout(&session_id, &player1);
    assert_eq!(winner, player1);

    let game = client.get_game(&session_id);
    assert_eq!(game.status, GameStatus::Timeout);
    assert_eq!(game.winner, Some(player1));
}

#[test]
fn test_invalid_public_inputs_rejected() {
    let (env, client, player1, player2) = setup_test();
    let session_id = 10u32;
    let drop_commitment = make_drop_commitment(&env, &[12u8; 32]);
    let (randomness_output, randomness_signature) =
        make_randomness_artifacts(&env, session_id, &drop_commitment);

    client.start_game(
        &session_id,
        &player1,
        &player2,
        &100_0000000,
        &100_0000000,
        &randomness_output,
        &drop_commitment,
        &randomness_signature,
    );

    let proof = Bytes::from_slice(&env, &[1, 2, 3]);

    let wrong_commitment = make_drop_commitment(&env, &[13u8; 32]);
    let wrong_inputs = make_public_inputs(&env, session_id, 0, 0u32, 0u32, &wrong_commitment, 10);

    let result = client.try_submit_ping(
        &session_id,
        &player1,
        &0u32,
        &10u32,
        &0u32,
        &0u32,
        &proof,
        &wrong_inputs,
    );
    assert_dead_drop_error(&result, Error::InvalidPublicInputs);
}

#[test]
fn test_invalid_public_inputs_count_rejected() {
    let (env, client, player1, player2) = setup_test();
    let session_id = 11u32;
    let drop_commitment = make_drop_commitment(&env, &[14u8; 32]);
    let (randomness_output, randomness_signature) =
        make_randomness_artifacts(&env, session_id, &drop_commitment);

    client.start_game(
        &session_id,
        &player1,
        &player2,
        &100_0000000,
        &100_0000000,
        &randomness_output,
        &drop_commitment,
        &randomness_signature,
    );

    let proof = Bytes::from_slice(&env, &[1, 2, 3]);

    let mut short_inputs = Vec::new(&env);
    short_inputs.push_back(u32_to_field_bytes(&env, session_id));
    short_inputs.push_back(u32_to_field_bytes(&env, 0));
    short_inputs.push_back(u32_to_field_bytes(&env, 0));

    let result = client.try_submit_ping(
        &session_id,
        &player1,
        &0u32,
        &10u32,
        &0u32,
        &0u32,
        &proof,
        &short_inputs,
    );
    assert_dead_drop_error(&result, Error::InvalidPublicInputs);
}

#[test]
fn test_invalid_coordinates_rejected() {
    let (env, client, player1, player2) = setup_test();
    let session_id = 120u32;
    let drop_commitment = make_drop_commitment(&env, &[15u8; 32]);
    let (randomness_output, randomness_signature) =
        make_randomness_artifacts(&env, session_id, &drop_commitment);

    client.start_game(
        &session_id,
        &player1,
        &player2,
        &100_0000000,
        &100_0000000,
        &randomness_output,
        &drop_commitment,
        &randomness_signature,
    );

    let public_inputs = make_public_inputs(&env, session_id, 0, 100u32, 0u32, &drop_commitment, 10);
    let proof = Bytes::from_slice(&env, &[1, 2, 3]);

    let result = client.try_submit_ping(
        &session_id,
        &player1,
        &0u32,
        &10u32,
        &100u32,
        &0u32,
        &proof,
        &public_inputs,
    );
    assert_dead_drop_error(&result, Error::InvalidDistance);
}

#[test]
fn test_invalid_distance_rejected() {
    let (env, client, player1, player2) = setup_test();
    let session_id = 121u32;
    let drop_commitment = make_drop_commitment(&env, &[16u8; 32]);
    let (randomness_output, randomness_signature) =
        make_randomness_artifacts(&env, session_id, &drop_commitment);

    client.start_game(
        &session_id,
        &player1,
        &player2,
        &100_0000000,
        &100_0000000,
        &randomness_output,
        &drop_commitment,
        &randomness_signature,
    );

    let public_inputs = make_public_inputs(&env, session_id, 0, 0u32, 0u32, &drop_commitment, 101u32);
    let proof = Bytes::from_slice(&env, &[1, 2, 3]);

    let result = client.try_submit_ping(
        &session_id,
        &player1,
        &0u32,
        &101u32,
        &0u32,
        &0u32,
        &proof,
        &public_inputs,
    );
    assert_dead_drop_error(&result, Error::InvalidDistance);
}

#[test]
fn test_proof_failure_returns_contract_error() {
    let (env, client, player1, player2) = setup_test();
    let reject_verifier = env.register(RejectVerifier, ());
    client.set_verifier(&reject_verifier);

    let session_id = 130u32;
    let drop_commitment = make_drop_commitment(&env, &[18u8; 32]);
    let (randomness_output, randomness_signature) =
        make_randomness_artifacts(&env, session_id, &drop_commitment);

    client.start_game(
        &session_id,
        &player1,
        &player2,
        &100_0000000,
        &100_0000000,
        &randomness_output,
        &drop_commitment,
        &randomness_signature,
    );

    let public_inputs = make_public_inputs(&env, session_id, 0, 0u32, 0u32, &drop_commitment, 10);
    let proof = Bytes::from_slice(&env, &[1, 2, 3]);

    let result = client.try_submit_ping(
        &session_id,
        &player1,
        &0u32,
        &10u32,
        &0u32,
        &0u32,
        &proof,
        &public_inputs,
    );
    assert_dead_drop_error(&result, Error::ProofVerificationFailed);
}

#[test]
fn test_randomness_verifier_contract_error() {
    let (env, client, player1, player2) = setup_test();
    let reject_randomness = env.register(RejectRandomnessVerifier, ());
    client.set_randomness_verifier(&reject_randomness);

    let session_id = 140u32;
    let drop_commitment = make_drop_commitment(&env, &[19u8; 32]);
    let (randomness_output, randomness_signature) =
        make_randomness_artifacts(&env, session_id, &drop_commitment);

    let result = client.try_start_game(
        &session_id,
        &player1,
        &player2,
        &100_0000000,
        &100_0000000,
        &randomness_output,
        &drop_commitment,
        &randomness_signature,
    );
    assert_dead_drop_error(&result, Error::RandomnessVerificationFailed);
}

#[test]
fn test_multiple_sessions_independent() {
    let (env, client, player1, player2) = setup_test();
    let player3 = Address::generate(&env);
    let player4 = Address::generate(&env);

    let drop1 = make_drop_commitment(&env, &[21u8; 32]);
    let drop2 = make_drop_commitment(&env, &[22u8; 32]);
    let (out1, sig1) = make_randomness_artifacts(&env, 1u32, &drop1);
    let (out2, sig2) = make_randomness_artifacts(&env, 2u32, &drop2);

    client.start_game(
        &1u32,
        &player1,
        &player2,
        &100_0000000,
        &100_0000000,
        &out1,
        &drop1,
        &sig1,
    );
    client.start_game(
        &2u32,
        &player3,
        &player4,
        &50_0000000,
        &50_0000000,
        &out2,
        &drop2,
        &sig2,
    );

    let game1 = client.get_game(&1u32);
    let game2 = client.get_game(&2u32);

    assert_eq!(game1.player1, player1);
    assert_eq!(game2.player1, player3);
    assert_eq!(game1.player1_points, 100_0000000);
    assert_eq!(game2.player1_points, 50_0000000);
    assert_eq!(game1.drop_commitment, drop1);
    assert_eq!(game2.drop_commitment, drop2);
}
