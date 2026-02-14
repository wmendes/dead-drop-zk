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
    pub fn add_game(_env: Env, _game_address: Address) {}
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
        timestamp: 1441065600,
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
    let admin = Address::generate(&env);

    let contract_id = env.register(
        DeadDropContract,
        (&admin, &hub_addr, &verifier_addr),
    );
    let client = DeadDropContractClient::new(&env, &contract_id);

    let player1 = Address::generate(&env);
    let player2 = Address::generate(&env);

    (env, client, player1, player2)
}

/// Create a fake commitment (arbitrary 32 bytes for testing).
/// In production this would be Poseidon2(x, y, salt) computed client-side.
fn make_commitment(env: &Env, _x: u32, _y: u32, salt: &[u8; 32]) -> BytesN<32> {
    // For test purposes, use SHA256 of (salt) as a deterministic 32-byte value.
    // The contract doesn't compute the commitment — it just stores whatever the client sends.
    let bytes = Bytes::from_array(env, salt);
    env.crypto().sha256(&bytes).into()
}

/// Convert a u32 to a 32-byte big-endian field element (matches contract logic).
fn u32_to_field_bytes(env: &Env, value: u32) -> BytesN<32> {
    let mut buf = [0u8; 32];
    buf[28..32].copy_from_slice(&value.to_be_bytes());
    BytesN::from_array(env, &buf)
}

/// Build public inputs vector matching the Noir circuit layout:
/// [session_id, turn, partial_dx, partial_dy, responder_commitment, expected_distance]
fn make_public_inputs(
    env: &Env,
    session_id: u32,
    turn: u32,
    partial_dx: u32,
    partial_dy: u32,
    responder_commitment: &BytesN<32>,
    distance: u32,
) -> Vec<BytesN<32>> {
    let mut inputs = Vec::new(env);
    inputs.push_back(u32_to_field_bytes(env, session_id));
    inputs.push_back(u32_to_field_bytes(env, turn));
    inputs.push_back(u32_to_field_bytes(env, partial_dx));
    inputs.push_back(u32_to_field_bytes(env, partial_dy));
    inputs.push_back(responder_commitment.clone());
    inputs.push_back(u32_to_field_bytes(env, distance));
    inputs
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
        Err(Err(_)) => panic!("Expected contract error {:?}, got invocation error", expected_error),
        Ok(Err(_)) => panic!("Expected contract error {:?}, got conversion error", expected_error),
        Ok(Ok(_)) => panic!("Expected error {:?}, but operation succeeded", expected_error),
    }
}

// ============================================================================
// Tests
// ============================================================================

#[test]
fn test_start_game() {
    let (_env, client, player1, player2) = setup_test();
    let session_id = 1u32;
    let points = 100_0000000i128;

    client.start_game(&session_id, &player1, &player2, &points, &points);

    let game = client.get_game(&session_id);
    assert_eq!(game.player1, player1);
    assert_eq!(game.player2, player2);
    assert_eq!(game.player1_points, points);
    assert_eq!(game.player2_points, points);
    assert_eq!(game.status, GameStatus::Created);
    assert!(game.winner.is_none());
    assert_eq!(game.current_turn, 0);
}

#[test]
fn test_self_play_rejected() {
    let (_env, client, player1, _player2) = setup_test();
    let same = player1.clone();
    let result = client.try_start_game(&1u32, &player1, &same, &100_0000000, &100_0000000);
    assert_dead_drop_error(&result, Error::SelfPlay);
}

#[test]
fn test_start_game_duplicate_session_rejected() {
    let (_env, client, player1, player2) = setup_test();
    let session_id = 77u32;
    let points = 100_0000000i128;

    client.start_game(&session_id, &player1, &player2, &points, &points);
    let result = client.try_start_game(&session_id, &player1, &player2, &points, &points);
    assert_dead_drop_error(&result, Error::LobbyAlreadyExists);
}

#[test]
fn test_start_game_invalid_points_rejected() {
    let (_env, client, player1, player2) = setup_test();
    let result = client.try_start_game(&88u32, &player1, &player2, &0i128, &100_0000000i128);
    assert_dead_drop_error(&result, Error::InvalidDistance);
}

#[test]
fn test_commit_secret() {
    let (env, client, player1, player2) = setup_test();
    let session_id = 2u32;
    let points = 100_0000000i128;
    client.start_game(&session_id, &player1, &player2, &points, &points);

    let salt1 = [1u8; 32];
    let salt2 = [2u8; 32];
    let c1 = make_commitment(&env, 10, 20, &salt1);
    let c2 = make_commitment(&env, 30, 40, &salt2);

    // First commit → Committing
    client.commit_secret(&session_id, &player1, &c1);
    let game = client.get_game(&session_id);
    assert_eq!(game.status, GameStatus::Committing);

    // Second commit → Active
    client.commit_secret(&session_id, &player2, &c2);
    let game = client.get_game(&session_id);
    assert_eq!(game.status, GameStatus::Active);
    assert_eq!(game.commitment1, c1);
    assert_eq!(game.commitment2, c2);
}

#[test]
fn test_double_commit_rejected() {
    let (env, client, player1, player2) = setup_test();
    let session_id = 3u32;
    client.start_game(&session_id, &player1, &player2, &100_0000000, &100_0000000);

    let salt = [1u8; 32];
    let c1 = make_commitment(&env, 10, 20, &salt);
    client.commit_secret(&session_id, &player1, &c1);

    let c1b = make_commitment(&env, 99, 99, &salt);
    let result = client.try_commit_secret(&session_id, &player1, &c1b);
    assert_dead_drop_error(&result, Error::AlreadyCommitted);
}

#[test]
fn test_non_player_commit_rejected() {
    let (env, client, player1, player2) = setup_test();
    let session_id = 4u32;
    client.start_game(&session_id, &player1, &player2, &100_0000000, &100_0000000);

    let outsider = Address::generate(&env);
    let c = make_commitment(&env, 10, 20, &[1u8; 32]);
    let result = client.try_commit_secret(&session_id, &outsider, &c);
    assert_dead_drop_error(&result, Error::NotPlayer);
}

#[test]
fn test_submit_ping() {
    let (env, client, player1, player2) = setup_test();
    let session_id = 5u32;
    let points = 100_0000000i128;
    client.start_game(&session_id, &player1, &player2, &points, &points);

    let salt1 = [1u8; 32];
    let salt2 = [2u8; 32];
    let c1 = make_commitment(&env, 10, 20, &salt1);
    let c2 = make_commitment(&env, 30, 40, &salt2);
    client.commit_secret(&session_id, &player1, &c1);
    client.commit_secret(&session_id, &player2, &c2);

    // Player1 pings (turn 0); always pass c1 then c2 (P1=a, P2=b)
    let distance = 25u32;
    let public_inputs = make_public_inputs(&env, session_id, 0, 0u32, 0u32, &c2, distance);
    let proof = Bytes::from_slice(&env, &[1, 2, 3]);

    let result = client.submit_ping(
        &session_id, &player1, &0u32, &distance, &0u32, &0u32, &proof, &public_inputs,
    );
    assert!(result.is_none()); // No winner yet

    let game = client.get_game(&session_id);
    assert_eq!(game.current_turn, 1);
    assert_eq!(game.whose_turn, 2); // Now player2's turn
    assert_eq!(game.player1_best_distance, 25);
}

#[test]
fn test_wrong_turn_rejected() {
    let (env, client, player1, player2) = setup_test();
    let session_id = 6u32;
    client.start_game(&session_id, &player1, &player2, &100_0000000, &100_0000000);

    let c1 = make_commitment(&env, 10, 20, &[1u8; 32]);
    let c2 = make_commitment(&env, 30, 40, &[2u8; 32]);
    client.commit_secret(&session_id, &player1, &c1);
    client.commit_secret(&session_id, &player2, &c2);

    // Player2 tries to go first (should be player1's turn)
    let public_inputs = make_public_inputs(&env, session_id, 0, 0u32, 0u32, &c2, 10);
    let proof = Bytes::from_slice(&env, &[1, 2, 3]);

    let result = client.try_submit_ping(
        &session_id, &player2, &0u32, &10u32, &0u32, &0u32, &proof, &public_inputs,
    );
    assert_dead_drop_error(&result, Error::NotYourTurn);
}

#[test]
fn test_distance_zero_wins() {
    let (env, client, player1, player2) = setup_test();
    let session_id = 7u32;
    let points = 100_0000000i128;
    client.start_game(&session_id, &player1, &player2, &points, &points);

    let c1 = make_commitment(&env, 10, 20, &[1u8; 32]);
    let c2 = make_commitment(&env, 30, 40, &[2u8; 32]);
    client.commit_secret(&session_id, &player1, &c1);
    client.commit_secret(&session_id, &player2, &c2);

    // Player1 pings with distance 0 → immediate win
    let public_inputs = make_public_inputs(&env, session_id, 0, 0u32, 0u32, &c2, 0);
    let proof = Bytes::from_slice(&env, &[1, 2, 3]);

    let result = client.submit_ping(
        &session_id, &player1, &0u32, &0u32, &0u32, &0u32, &proof, &public_inputs,
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
    client.start_game(&session_id, &player1, &player2, &points, &points);

    let c1 = make_commitment(&env, 10, 20, &[1u8; 32]);
    let c2 = make_commitment(&env, 30, 40, &[2u8; 32]);
    client.commit_secret(&session_id, &player1, &c1);
    client.commit_secret(&session_id, &player2, &c2);

    let proof = Bytes::from_slice(&env, &[1, 2, 3]);

    // Play 30 turns: player1 gets closer (distance 5), player2 gets distance 10
    for turn in 0u32..30 {
        let is_p1_turn = turn % 2 == 0;
        if is_p1_turn {
            let distance = 5u32;
            let public_inputs = make_public_inputs(&env, session_id, turn, 0u32, 0u32, &c2, distance);
            let result = client.submit_ping(
                &session_id, &player1, &turn, &distance, &0u32, &0u32, &proof, &public_inputs,
            );
            if turn == 29 {
                // This shouldn't happen since turn 29 is odd
                unreachable!();
            }
            // Not the last turn yet
            if turn < 28 {
                assert!(result.is_none());
            }
        } else {
            let distance = 10u32;
            let public_inputs = make_public_inputs(&env, session_id, turn, 0u32, 0u32, &c1, distance);
            let result = client.submit_ping(
                &session_id, &player2, &turn, &distance, &0u32, &0u32, &proof, &public_inputs,
            );
            if turn == 29 {
                // Last turn → game ends
                assert!(result.is_some());
                assert_eq!(result.unwrap(), player1); // player1 had distance 5 < 10
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
    client.start_game(&session_id, &player1, &player2, &100_0000000, &100_0000000);

    let c1 = make_commitment(&env, 10, 20, &[1u8; 32]);
    let c2 = make_commitment(&env, 30, 40, &[2u8; 32]);
    client.commit_secret(&session_id, &player1, &c1);
    client.commit_secret(&session_id, &player2, &c2);

    // Timeout not reached yet
    let result = client.try_force_timeout(&session_id, &player1);
    assert_dead_drop_error(&result, Error::TimeoutNotReached);

    // Advance ledger past timeout threshold
    env.ledger().set(soroban_sdk::testutils::LedgerInfo {
        timestamp: 1441065600 + 4000,
        protocol_version: 25,
        sequence_number: 100 + 700, // Past 600-ledger timeout
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
    client.start_game(&session_id, &player1, &player2, &100_0000000, &100_0000000);

    let c1 = make_commitment(&env, 10, 20, &[1u8; 32]);
    let c2 = make_commitment(&env, 30, 40, &[2u8; 32]);
    client.commit_secret(&session_id, &player1, &c1);
    client.commit_secret(&session_id, &player2, &c2);

    let proof = Bytes::from_slice(&env, &[1, 2, 3]);

    // Wrong public inputs: turn 0 responder is player2, so using player1 commitment is invalid
    let wrong_inputs = make_public_inputs(&env, session_id, 0, 0u32, 0u32, &c1, 10);

    let result = client.try_submit_ping(
        &session_id, &player1, &0u32, &10u32, &0u32, &0u32, &proof, &wrong_inputs,
    );
    assert_dead_drop_error(&result, Error::InvalidPublicInputs);
}

#[test]
fn test_invalid_public_inputs_count_rejected() {
    let (env, client, player1, player2) = setup_test();
    let session_id = 11u32;
    client.start_game(&session_id, &player1, &player2, &100_0000000, &100_0000000);

    let c1 = make_commitment(&env, 10, 20, &[1u8; 32]);
    let c2 = make_commitment(&env, 30, 40, &[2u8; 32]);
    client.commit_secret(&session_id, &player1, &c1);
    client.commit_secret(&session_id, &player2, &c2);

    let proof = Bytes::from_slice(&env, &[1, 2, 3]);

    // Too few public inputs (only 3 instead of 6)
    let mut short_inputs = Vec::new(&env);
    short_inputs.push_back(u32_to_field_bytes(&env, session_id));
    short_inputs.push_back(u32_to_field_bytes(&env, 0));
    short_inputs.push_back(u32_to_field_bytes(&env, 0));

    let result = client.try_submit_ping(
        &session_id, &player1, &0u32, &10u32, &0u32, &0u32, &proof, &short_inputs,
    );
    assert_dead_drop_error(&result, Error::InvalidPublicInputs);
}

#[test]
fn test_invalid_coordinates_rejected() {
    let (env, client, player1, player2) = setup_test();
    let session_id = 120u32;
    client.start_game(&session_id, &player1, &player2, &100_0000000, &100_0000000);

    let c1 = make_commitment(&env, 10, 20, &[1u8; 32]);
    let c2 = make_commitment(&env, 30, 40, &[2u8; 32]);
    client.commit_secret(&session_id, &player1, &c1);
    client.commit_secret(&session_id, &player2, &c2);

    let public_inputs = make_public_inputs(&env, session_id, 0, 100u32, 0u32, &c2, 10);
    let proof = Bytes::from_slice(&env, &[1, 2, 3]);

    let result = client.try_submit_ping(
        &session_id, &player1, &0u32, &10u32, &100u32, &0u32, &proof, &public_inputs,
    );
    assert_dead_drop_error(&result, Error::InvalidDistance);
}

#[test]
fn test_invalid_distance_rejected() {
    let (env, client, player1, player2) = setup_test();
    let session_id = 121u32;
    client.start_game(&session_id, &player1, &player2, &100_0000000, &100_0000000);

    let c1 = make_commitment(&env, 10, 20, &[1u8; 32]);
    let c2 = make_commitment(&env, 30, 40, &[2u8; 32]);
    client.commit_secret(&session_id, &player1, &c1);
    client.commit_secret(&session_id, &player2, &c2);

    let public_inputs = make_public_inputs(&env, session_id, 0, 0u32, 0u32, &c2, 101u32);
    let proof = Bytes::from_slice(&env, &[1, 2, 3]);

    let result = client.try_submit_ping(
        &session_id, &player1, &0u32, &101u32, &0u32, &0u32, &proof, &public_inputs,
    );
    assert_dead_drop_error(&result, Error::InvalidDistance);
}

#[test]
fn test_cannot_ping_before_active() {
    let (env, client, player1, player2) = setup_test();
    let session_id = 12u32;
    client.start_game(&session_id, &player1, &player2, &100_0000000, &100_0000000);

    // Only player1 commits (game is in Committing, not Active)
    let c1 = make_commitment(&env, 10, 20, &[1u8; 32]);
    client.commit_secret(&session_id, &player1, &c1);

    let public_inputs = Vec::new(&env); // Doesn't matter, will fail on status check
    let proof = Bytes::from_slice(&env, &[1, 2, 3]);

    let result = client.try_submit_ping(
        &session_id, &player1, &0u32, &10u32, &0u32, &0u32, &proof, &public_inputs,
    );
    assert_dead_drop_error(&result, Error::InvalidGameStatus);
}

#[test]
fn test_multiple_sessions_independent() {
    let (env, client, player1, player2) = setup_test();
    let player3 = Address::generate(&env);
    let player4 = Address::generate(&env);

    client.start_game(&1u32, &player1, &player2, &100_0000000, &100_0000000);
    client.start_game(&2u32, &player3, &player4, &50_0000000, &50_0000000);

    let game1 = client.get_game(&1u32);
    let game2 = client.get_game(&2u32);

    assert_eq!(game1.player1, player1);
    assert_eq!(game2.player1, player3);
    assert_eq!(game1.player1_points, 100_0000000);
    assert_eq!(game2.player1_points, 50_0000000);
}

#[test]
fn test_game_not_found() {
    let (_env, client, _player1, _player2) = setup_test();
    let result = client.try_get_game(&999u32);
    assert_dead_drop_error(&result, Error::GameNotFound);
}

#[test]
fn test_alternating_turns() {
    let (env, client, player1, player2) = setup_test();
    let session_id = 13u32;
    client.start_game(&session_id, &player1, &player2, &100_0000000, &100_0000000);

    let c1 = make_commitment(&env, 10, 20, &[1u8; 32]);
    let c2 = make_commitment(&env, 30, 40, &[2u8; 32]);
    client.commit_secret(&session_id, &player1, &c1);
    client.commit_secret(&session_id, &player2, &c2);

    let proof = Bytes::from_slice(&env, &[1, 2, 3]);

    // Turn 0: Player1 pings
    let pi0 = make_public_inputs(&env, session_id, 0, 0u32, 0u32, &c2, 20);
    client.submit_ping(&session_id, &player1, &0u32, &20u32, &0u32, &0u32, &proof, &pi0);

    let game = client.get_game(&session_id);
    assert_eq!(game.whose_turn, 2);
    assert_eq!(game.current_turn, 1);

    // Turn 1: Player2 pings
    let pi1 = make_public_inputs(&env, session_id, 1, 0u32, 0u32, &c1, 15);
    client.submit_ping(&session_id, &player2, &1u32, &15u32, &0u32, &0u32, &proof, &pi1);

    let game = client.get_game(&session_id);
    assert_eq!(game.whose_turn, 1);
    assert_eq!(game.current_turn, 2);
    assert_eq!(game.player1_best_distance, 20);
    assert_eq!(game.player2_best_distance, 15);
}

#[test]
fn test_best_distance_updates() {
    let (env, client, player1, player2) = setup_test();
    let session_id = 14u32;
    client.start_game(&session_id, &player1, &player2, &100_0000000, &100_0000000);

    let c1 = make_commitment(&env, 10, 20, &[1u8; 32]);
    let c2 = make_commitment(&env, 30, 40, &[2u8; 32]);
    client.commit_secret(&session_id, &player1, &c1);
    client.commit_secret(&session_id, &player2, &c2);

    let proof = Bytes::from_slice(&env, &[1, 2, 3]);

    // Turn 0: Player1 gets distance 50
    let pi0 = make_public_inputs(&env, session_id, 0, 0u32, 0u32, &c2, 50);
    client.submit_ping(&session_id, &player1, &0u32, &50u32, &0u32, &0u32, &proof, &pi0);
    assert_eq!(client.get_game(&session_id).player1_best_distance, 50);

    // Turn 1: Player2 gets distance 30
    let pi1 = make_public_inputs(&env, session_id, 1, 0u32, 0u32, &c1, 30);
    client.submit_ping(&session_id, &player2, &1u32, &30u32, &0u32, &0u32, &proof, &pi1);

    // Turn 2: Player1 gets distance 10 (better!)
    let pi2 = make_public_inputs(&env, session_id, 2, 0u32, 0u32, &c2, 10);
    client.submit_ping(&session_id, &player1, &2u32, &10u32, &0u32, &0u32, &proof, &pi2);
    assert_eq!(client.get_game(&session_id).player1_best_distance, 10);

    // Turn 3: Player2 gets distance 40 (worse, best stays 30)
    let pi3 = make_public_inputs(&env, session_id, 3, 0u32, 0u32, &c1, 40);
    client.submit_ping(&session_id, &player2, &3u32, &40u32, &0u32, &0u32, &proof, &pi3);
    assert_eq!(client.get_game(&session_id).player2_best_distance, 30);
}

// ============================================================================
// Lobby Tests
// ============================================================================

#[test]
fn test_open_and_join_game() {
    let (_env, client, player1, player2) = setup_test();
    let session_id = 100u32;
    let points = 100_0000000i128;

    // Player1 opens a lobby
    client.open_game(&session_id, &player1, &points);

    // Lobby should exist
    let lobby = client.get_lobby(&session_id);
    assert_eq!(lobby.host, player1);
    assert_eq!(lobby.host_points, points);

    // Player2 joins the lobby
    client.join_game(&session_id, &player2, &points);

    // Lobby should be gone (consumed)
    let result = client.try_get_lobby(&session_id);
    assert_dead_drop_error(&result, crate::Error::LobbyNotFound);

    // Game should exist and be in Created state
    let game = client.get_game(&session_id);
    assert_eq!(game.player1, player1);
    assert_eq!(game.player2, player2);
    assert_eq!(game.player1_points, points);
    assert_eq!(game.player2_points, points);
    assert_eq!(game.status, GameStatus::Created);
}

#[test]
fn test_join_nonexistent_lobby() {
    let (_env, client, _player1, player2) = setup_test();
    let session_id = 101u32;
    let points = 100_0000000i128;

    // Try to join a lobby that doesn't exist
    let result = client.try_join_game(&session_id, &player2, &points);
    assert_dead_drop_error(&result, Error::LobbyNotFound);
}

#[test]
fn test_join_self_play_rejected() {
    let (_env, client, player1, _player2) = setup_test();
    let session_id = 102u32;
    let points = 100_0000000i128;

    // Player1 opens a lobby
    client.open_game(&session_id, &player1, &points);

    // Player1 tries to join their own lobby
    let result = client.try_join_game(&session_id, &player1, &points);
    assert_dead_drop_error(&result, Error::SelfPlay);
}

#[test]
fn test_open_duplicate_session_rejected() {
    let (_env, client, player1, player2) = setup_test();
    let session_id = 103u32;
    let points = 100_0000000i128;

    // Player1 opens a lobby
    client.open_game(&session_id, &player1, &points);

    // Try to open another lobby with the same session_id
    let result = client.try_open_game(&session_id, &player2, &points);
    assert_dead_drop_error(&result, Error::LobbyAlreadyExists);
}

#[test]
fn test_open_game_invalid_points_rejected() {
    let (_env, client, player1, _player2) = setup_test();
    let session_id = 104u32;
    let result = client.try_open_game(&session_id, &player1, &0i128);
    assert_dead_drop_error(&result, Error::InvalidDistance);
}

#[test]
fn test_join_game_invalid_points_rejected() {
    let (_env, client, player1, player2) = setup_test();
    let session_id = 105u32;
    let points = 100_0000000i128;

    client.open_game(&session_id, &player1, &points);
    let result = client.try_join_game(&session_id, &player2, &0i128);
    assert_dead_drop_error(&result, Error::InvalidDistance);
}

#[test]
fn test_proof_failure_returns_contract_error() {
    let (env, client, player1, player2) = setup_test();
    let reject_verifier = env.register(RejectVerifier, ());
    client.set_verifier(&reject_verifier);

    let session_id = 130u32;
    client.start_game(&session_id, &player1, &player2, &100_0000000, &100_0000000);

    let c1 = make_commitment(&env, 10, 20, &[1u8; 32]);
    let c2 = make_commitment(&env, 30, 40, &[2u8; 32]);
    client.commit_secret(&session_id, &player1, &c1);
    client.commit_secret(&session_id, &player2, &c2);

    let public_inputs = make_public_inputs(&env, session_id, 0, 0u32, 0u32, &c2, 10);
    let proof = Bytes::from_slice(&env, &[1, 2, 3]);

    let result = client.try_submit_ping(
        &session_id, &player1, &0u32, &10u32, &0u32, &0u32, &proof, &public_inputs,
    );
    assert_dead_drop_error(&result, Error::ProofVerificationFailed);
}

#[test]
fn test_create_and_join_game() {
    let (_env, client, player1, player2) = setup_test();
    let session_id = 200u32;
    let points = 100_0000000i128;

    client.start_game(&session_id, &player1, &player2, &points, &points);

    let game = client.get_game(&session_id);
    assert_eq!(game.player1, player1);
    assert_eq!(game.player2, player2);
    assert_eq!(game.status, GameStatus::Created);
    assert!(game.winner.is_none());
}
