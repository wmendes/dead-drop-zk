#![no_std]

//! # Dead Drop – 1v1 ZK Scavenger Hunt
//!
//! Two players each commit a secret coordinate on a 100×100 grid.
//! The hidden "Drop" location is the modular sum of their secrets.
//! Players alternate pinging the grid and a ZK proof verifies the
//! Manhattan distance without revealing the responder's secret.
//!
//! **Game Hub Integration:**
//! This game is Game Hub-aware. All sessions go through `start_game`
//! and `end_game` on the Game Hub contract.

use soroban_sdk::{
    contract, contractclient, contracterror, contractimpl, contracttype,
    Address, Bytes, BytesN, Env, IntoVal, InvokeError, Symbol, Val, Vec,
    vec,
};

// ============================================================================
// Game Hub Interface
// ============================================================================

#[contractclient(name = "GameHubClient")]
pub trait GameHub {
    fn start_game(
        env: Env,
        game_id: Address,
        session_id: u32,
        player1: Address,
        player2: Address,
        player1_points: i128,
        player2_points: i128,
    );

    fn end_game(env: Env, session_id: u32, player1_won: bool);
}

// ============================================================================
// Errors
// ============================================================================

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    GameNotFound = 1,
    NotPlayer = 2,
    GameAlreadyEnded = 3,
    InvalidGameStatus = 4,
    AlreadyCommitted = 5,
    NotYourTurn = 6,
    InvalidTurn = 7,
    InvalidImageId = 8,
    InvalidJournalHash = 9,
    ProofVerificationFailed = 10,
    TimeoutNotReached = 11,
    InvalidDistance = 12,
    MaxTurnsReached = 13,
    LobbyNotFound = 14,
    LobbyAlreadyExists = 15,
    SelfPlay = 16,
}

// ============================================================================
// Data Types
// ============================================================================

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum GameStatus {
    Created = 0,
    Committing = 1,
    Active = 2,
    Completed = 3,
    Timeout = 4,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Game {
    pub player1: Address,
    pub player2: Address,
    pub player1_points: i128,
    pub player2_points: i128,
    pub commitment1: BytesN<32>,
    pub commitment2: BytesN<32>,
    pub status: GameStatus,
    pub current_turn: u32,
    pub whose_turn: u32, // 1 = player1 pings, 2 = player2 pings
    pub player1_best_distance: u32,
    pub player2_best_distance: u32,
    pub winner: Option<Address>,
    pub last_action_ledger: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Lobby {
    pub host: Address,
    pub host_points: i128,
    pub created_ledger: u32,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Game(u32),
    Lobby(u32),
    GameHubAddress,
    Admin,
    VerifierId,
    PingImageId,
}

// ============================================================================
// Constants
// ============================================================================

/// 30-day TTL in ledgers (~5 seconds per ledger)
const GAME_TTL_LEDGERS: u32 = 518_400;

/// Maximum number of turns (each player gets 15 pings)
const MAX_TURNS: u32 = 30;

/// Timeout threshold in ledgers (~50 minutes = 600 ledgers)
const TIMEOUT_LEDGERS: u32 = 600;

/// Sentinel value for "no distance recorded yet"
const NO_DISTANCE: u32 = u32::MAX;

/// Sentinel value for "no commitment yet"
const EMPTY_COMMITMENT: [u8; 32] = [0u8; 32];

// ============================================================================
// Contract
// ============================================================================

#[contract]
pub struct DeadDropContract;

#[contractimpl]
impl DeadDropContract {
    /// Initialize the contract.
    pub fn __constructor(
        env: Env,
        admin: Address,
        game_hub: Address,
        verifier_id: Address,
        ping_image_id: BytesN<32>,
    ) {
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage()
            .instance()
            .set(&DataKey::GameHubAddress, &game_hub);
        env.storage()
            .instance()
            .set(&DataKey::VerifierId, &verifier_id);
        env.storage()
            .instance()
            .set(&DataKey::PingImageId, &ping_image_id);
    }

    /// Start a new game session between two players.
    pub fn start_game(
        env: Env,
        session_id: u32,
        player1: Address,
        player2: Address,
        player1_points: i128,
        player2_points: i128,
    ) -> Result<(), Error> {
        // Prevent self-play
        if player1 == player2 {
            return Err(Error::SelfPlay);
        }

        // Require auth from both players for their points
        player1.require_auth_for_args(
            vec![&env, session_id.into_val(&env), player1_points.into_val(&env)],
        );
        player2.require_auth_for_args(
            vec![&env, session_id.into_val(&env), player2_points.into_val(&env)],
        );

        // Call Game Hub
        let game_hub_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::GameHubAddress)
            .expect("GameHub address not set");
        let game_hub = GameHubClient::new(&env, &game_hub_addr);
        game_hub.start_game(
            &env.current_contract_address(),
            &session_id,
            &player1,
            &player2,
            &player1_points,
            &player2_points,
        );

        let game = Game {
            player1,
            player2,
            player1_points,
            player2_points,
            commitment1: BytesN::from_array(&env, &EMPTY_COMMITMENT),
            commitment2: BytesN::from_array(&env, &EMPTY_COMMITMENT),
            status: GameStatus::Created,
            current_turn: 0,
            whose_turn: 1,
            player1_best_distance: NO_DISTANCE,
            player2_best_distance: NO_DISTANCE,
            winner: None,
            last_action_ledger: env.ledger().sequence(),
        };

        let key = DataKey::Game(session_id);
        env.storage().temporary().set(&key, &game);
        env.storage()
            .temporary()
            .extend_ttl(&key, GAME_TTL_LEDGERS, GAME_TTL_LEDGERS);

        Ok(())
    }

    /// Submit a SHA-256 commitment of the player's secret coordinates.
    /// commitment = SHA256(x_le || y_le || salt)   (4 + 4 + 32 = 40 bytes)
    pub fn commit_secret(
        env: Env,
        session_id: u32,
        player: Address,
        commitment: BytesN<32>,
    ) -> Result<(), Error> {
        player.require_auth();

        let key = DataKey::Game(session_id);
        let mut game: Game = env
            .storage()
            .temporary()
            .get(&key)
            .ok_or(Error::GameNotFound)?;

        if game.winner.is_some() {
            return Err(Error::GameAlreadyEnded);
        }

        let empty = BytesN::from_array(&env, &EMPTY_COMMITMENT);

        if player == game.player1 {
            if game.commitment1 != empty {
                return Err(Error::AlreadyCommitted);
            }
            game.commitment1 = commitment;
        } else if player == game.player2 {
            if game.commitment2 != empty {
                return Err(Error::AlreadyCommitted);
            }
            game.commitment2 = commitment;
        } else {
            return Err(Error::NotPlayer);
        }

        // Transition status
        let both_committed =
            game.commitment1 != empty && game.commitment2 != empty;
        if both_committed {
            game.status = GameStatus::Active;
        } else {
            game.status = GameStatus::Committing;
        }

        game.last_action_ledger = env.ledger().sequence();

        env.storage().temporary().set(&key, &game);
        env.storage()
            .temporary()
            .extend_ttl(&key, GAME_TTL_LEDGERS, GAME_TTL_LEDGERS);

        Ok(())
    }

    /// Submit a ping result with ZK proof verification.
    ///
    /// The pinging player sends a coordinate to the responder off-chain.
    /// The responder computes the Manhattan distance and generates a ZK proof.
    /// This method verifies the proof and records the distance.
    ///
    /// Journal layout: [session_id(4) || turn(4) || distance(4) || commitment(32)] = 44 bytes LE
    pub fn submit_ping(
        env: Env,
        session_id: u32,
        player: Address,
        turn: u32,
        distance: u32,
        x: u32,
        y: u32,
        journal_hash: BytesN<32>,
        image_id: BytesN<32>,
        seal: Bytes,
    ) -> Result<Option<Address>, Error> {
        player.require_auth();

        let key = DataKey::Game(session_id);
        let mut game: Game = env
            .storage()
            .temporary()
            .get(&key)
            .ok_or(Error::GameNotFound)?;

        if game.winner.is_some() {
            return Err(Error::GameAlreadyEnded);
        }
        if game.status != GameStatus::Active {
            return Err(Error::InvalidGameStatus);
        }
        if turn != game.current_turn {
            return Err(Error::InvalidTurn);
        }
        if game.current_turn >= MAX_TURNS {
            return Err(Error::MaxTurnsReached);
        }

        // Determine who is pinging and who is responding
        let is_player1_turn = game.whose_turn == 1;
        let (pinger, responder_commitment) = if is_player1_turn {
            // Player1 is pinging → responder is player2 → proof verifies against commitment2
            if player != game.player1 {
                return Err(Error::NotYourTurn);
            }
            (&game.player1, &game.commitment2)
        } else {
            // Player2 is pinging → responder is player1 → proof verifies against commitment1
            if player != game.player2 {
                return Err(Error::NotYourTurn);
            }
            (&game.player2, &game.commitment1)
        };

        // Verify image_id matches stored value
        let stored_image_id: BytesN<32> = env
            .storage()
            .instance()
            .get(&DataKey::PingImageId)
            .expect("PingImageId not set");
        if stored_image_id != image_id {
            return Err(Error::InvalidImageId);
        }

        // Reconstruct expected journal and verify hash
        // Journal: [session_id(4) || turn(4) || distance(4) || commitment(32)] = 44 bytes LE
        let mut journal_data = [0u8; 44];
        journal_data[0..4].copy_from_slice(&session_id.to_le_bytes());
        journal_data[4..8].copy_from_slice(&turn.to_le_bytes());
        journal_data[8..12].copy_from_slice(&distance.to_le_bytes());

        let commitment_bytes = responder_commitment.to_array();
        journal_data[12..44].copy_from_slice(&commitment_bytes);

        let journal_bytes = Bytes::from_array(&env, &journal_data);
        let expected_journal_hash: BytesN<32> = env.crypto().sha256(&journal_bytes).into();

        if journal_hash != expected_journal_hash {
            return Err(Error::InvalidJournalHash);
        }

        // Verify ZK proof via cross-contract call
        let verifier_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::VerifierId)
            .expect("VerifierId not set");

        verify_proof(&env, &verifier_addr, &journal_hash, &image_id, &seal);

        // Emit ping event for frontend syncing
        // Topic: ["ping", session_id]
        // Data: [player, turn, distance, x, y]
        env.events().publish(
            (Symbol::new(&env, "ping"), session_id),
            (player.clone(), turn, distance, x, y),
        );

        // Record distance and update best
        if is_player1_turn {
            if distance < game.player1_best_distance {
                game.player1_best_distance = distance;
            }
        } else {
            if distance < game.player2_best_distance {
                game.player2_best_distance = distance;
            }
        }

        // Check for immediate win (distance == 0 means found the drop)
        if distance == 0 {
            let winner = pinger.clone();
            game.winner = Some(winner.clone());
            game.status = GameStatus::Completed;
            game.last_action_ledger = env.ledger().sequence();

            env.storage().temporary().set(&key, &game);
            env.storage()
                .temporary()
                .extend_ttl(&key, GAME_TTL_LEDGERS, GAME_TTL_LEDGERS);

            // Report to Game Hub
            let game_hub_addr: Address = env
                .storage()
                .instance()
                .get(&DataKey::GameHubAddress)
                .expect("GameHub address not set");
            let game_hub = GameHubClient::new(&env, &game_hub_addr);
            let player1_won = winner == game.player1;
            game_hub.end_game(&session_id, &player1_won);

            return Ok(Some(winner));
        }

        // Advance turn
        game.current_turn += 1;
        game.whose_turn = if is_player1_turn { 2 } else { 1 };
        game.last_action_ledger = env.ledger().sequence();

        // Check if max turns reached → determine winner by best distance
        if game.current_turn >= MAX_TURNS {
            let winner = Self::determine_winner_by_distance(&game);
            game.winner = Some(winner.clone());
            game.status = GameStatus::Completed;

            env.storage().temporary().set(&key, &game);
            env.storage()
                .temporary()
                .extend_ttl(&key, GAME_TTL_LEDGERS, GAME_TTL_LEDGERS);

            // Report to Game Hub
            let game_hub_addr: Address = env
                .storage()
                .instance()
                .get(&DataKey::GameHubAddress)
                .expect("GameHub address not set");
            let game_hub = GameHubClient::new(&env, &game_hub_addr);
            let player1_won = winner == game.player1;
            game_hub.end_game(&session_id, &player1_won);

            return Ok(Some(winner));
        }

        env.storage().temporary().set(&key, &game);
        env.storage()
            .temporary()
            .extend_ttl(&key, GAME_TTL_LEDGERS, GAME_TTL_LEDGERS);

        Ok(None)
    }

    /// Force a timeout win if the opponent has been AFK.
    pub fn force_timeout(
        env: Env,
        session_id: u32,
        player: Address,
    ) -> Result<Address, Error> {
        player.require_auth();

        let key = DataKey::Game(session_id);
        let mut game: Game = env
            .storage()
            .temporary()
            .get(&key)
            .ok_or(Error::GameNotFound)?;

        if game.winner.is_some() {
            return Err(Error::GameAlreadyEnded);
        }

        // Must be a participant
        if player != game.player1 && player != game.player2 {
            return Err(Error::NotPlayer);
        }

        // Check timeout
        let current_ledger = env.ledger().sequence();
        if current_ledger < game.last_action_ledger + TIMEOUT_LEDGERS {
            return Err(Error::TimeoutNotReached);
        }

        // The player claiming timeout wins (opponent was AFK)
        let winner = player.clone();
        game.winner = Some(winner.clone());
        game.status = GameStatus::Timeout;
        game.last_action_ledger = current_ledger;

        env.storage().temporary().set(&key, &game);
        env.storage()
            .temporary()
            .extend_ttl(&key, GAME_TTL_LEDGERS, GAME_TTL_LEDGERS);

        // Report to Game Hub
        let game_hub_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::GameHubAddress)
            .expect("GameHub address not set");
        let game_hub = GameHubClient::new(&env, &game_hub_addr);
        let player1_won = winner == game.player1;
        game_hub.end_game(&session_id, &player1_won);

        Ok(winner)
    }

    /// Read-only game state query.
    pub fn get_game(env: Env, session_id: u32) -> Result<Game, Error> {
        let key = DataKey::Game(session_id);
        env.storage()
            .temporary()
            .get(&key)
            .ok_or(Error::GameNotFound)
    }

    /// Open a lobby for a game session. Player 1 creates it with a room code (session_id).
    /// This is single-sig and does not require the opponent's address.
    pub fn open_game(
        env: Env,
        session_id: u32,
        host: Address,
        host_points: i128,
    ) -> Result<(), Error> {
        host.require_auth_for_args(
            vec![&env, session_id.into_val(&env), host_points.into_val(&env)],
        );

        // Reject if session slot is already in use
        let lobby_key = DataKey::Lobby(session_id);
        if env.storage().temporary().has(&lobby_key) {
            return Err(Error::LobbyAlreadyExists);
        }
        let game_key = DataKey::Game(session_id);
        if env.storage().temporary().has(&game_key) {
            return Err(Error::LobbyAlreadyExists);
        }

        let lobby = Lobby {
            host,
            host_points,
            created_ledger: env.ledger().sequence(),
        };
        env.storage().temporary().set(&lobby_key, &lobby);
        env.storage()
            .temporary()
            .extend_ttl(&lobby_key, GAME_TTL_LEDGERS, GAME_TTL_LEDGERS);

        Ok(())
    }

    /// Join an existing lobby. Player 2 joins with the room code (session_id).
    /// This is single-sig and calls Game Hub to start the game.
    pub fn join_game(
        env: Env,
        session_id: u32,
        joiner: Address,
        joiner_points: i128,
    ) -> Result<(), Error> {
        joiner.require_auth_for_args(
            vec![&env, session_id.into_val(&env), joiner_points.into_val(&env)],
        );

        let lobby_key = DataKey::Lobby(session_id);
        let lobby: Lobby = env
            .storage()
            .temporary()
            .get(&lobby_key)
            .ok_or(Error::LobbyNotFound)?;

        if joiner == lobby.host {
            return Err(Error::SelfPlay);
        }

        // Consume the lobby
        env.storage().temporary().remove(&lobby_key);

        // Now both players are known — call Game Hub
        let hub_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::GameHubAddress)
            .expect("GameHub address not set");
        let game_hub = GameHubClient::new(&env, &hub_addr);
        game_hub.start_game(
            &env.current_contract_address(),
            &session_id,
            &lobby.host,
            &joiner,
            &lobby.host_points,
            &joiner_points,
        );

        // Create the game
        let game = Game {
            player1: lobby.host,
            player2: joiner,
            player1_points: lobby.host_points,
            player2_points: joiner_points,
            commitment1: BytesN::from_array(&env, &EMPTY_COMMITMENT),
            commitment2: BytesN::from_array(&env, &EMPTY_COMMITMENT),
            status: GameStatus::Created,
            current_turn: 0,
            whose_turn: 1,
            player1_best_distance: NO_DISTANCE,
            player2_best_distance: NO_DISTANCE,
            winner: None,
            last_action_ledger: env.ledger().sequence(),
        };

        let game_key = DataKey::Game(session_id);
        env.storage().temporary().set(&game_key, &game);
        env.storage()
            .temporary()
            .extend_ttl(&game_key, GAME_TTL_LEDGERS, GAME_TTL_LEDGERS);

        Ok(())
    }

    /// Read-only lobby state query.
    pub fn get_lobby(env: Env, session_id: u32) -> Result<Lobby, Error> {
        env.storage()
            .temporary()
            .get(&DataKey::Lobby(session_id))
            .ok_or(Error::LobbyNotFound)
    }

    // ========================================================================
    // Admin Functions
    // ========================================================================

    pub fn get_admin(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("Admin not set")
    }

    pub fn set_admin(env: Env, new_admin: Address) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("Admin not set");
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &new_admin);
    }

    pub fn get_hub(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::GameHubAddress)
            .expect("GameHub address not set")
    }

    pub fn set_hub(env: Env, new_hub: Address) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("Admin not set");
        admin.require_auth();
        env.storage()
            .instance()
            .set(&DataKey::GameHubAddress, &new_hub);
    }

    pub fn set_verifier(env: Env, new_verifier: Address) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("Admin not set");
        admin.require_auth();
        env.storage()
            .instance()
            .set(&DataKey::VerifierId, &new_verifier);
    }

    pub fn set_image_id(env: Env, new_image_id: BytesN<32>) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("Admin not set");
        admin.require_auth();
        env.storage()
            .instance()
            .set(&DataKey::PingImageId, &new_image_id);
    }

    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("Admin not set");
        admin.require_auth();
        env.deployer().update_current_contract_wasm(new_wasm_hash);
    }

    // ========================================================================
    // Internal Helpers
    // ========================================================================

    fn determine_winner_by_distance(game: &Game) -> Address {
        // Lower best distance wins. Player1 wins ties.
        if game.player1_best_distance <= game.player2_best_distance {
            game.player1.clone()
        } else {
            game.player2.clone()
        }
    }
}

// ============================================================================
// ZK Proof Verification (cross-contract call)
// ============================================================================

fn verify_proof(
    env: &Env,
    verifier_id: &Address,
    journal_hash: &BytesN<32>,
    image_id: &BytesN<32>,
    seal: &Bytes,
) {
    let mut args: Vec<Val> = Vec::new(env);
    args.push_back(seal.into_val(env));
    args.push_back(image_id.into_val(env));
    args.push_back(journal_hash.into_val(env));

    let result = env.try_invoke_contract::<Val, InvokeError>(
        verifier_id,
        &Symbol::new(env, "verify"),
        args,
    );
    match result {
        Ok(Ok(_)) => {}
        Ok(Err(_)) | Err(_) => panic!("ZK proof verification failed"),
    }
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod test;
