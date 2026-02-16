#![no_std]

//! # Dead Drop – 1v1 ZK Scavenger Hunt
//!
//! Two players compete to find a hidden drop location on a 100×100 toroidal grid.
//! The hidden drop commitment is fixed at game start using a verifier-backed
//! randomness attestation. Players alternate submitting pings; each ping includes
//! exact public coordinates and a ZK proof that the reported distance is correct
//! for the hidden committed drop.

use soroban_sdk::{
    contract, contractclient, contracterror, contractimpl, contracttype,
    vec, Address, Bytes, BytesN, Env, IntoVal, InvokeError, Symbol, Val, Vec,
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
// Randomness Verifier Interface
// ============================================================================

#[contractclient(name = "RandomnessVerifierClient")]
pub trait RandomnessVerifier {
    fn verify_randomness(
        env: Env,
        session_id: u32,
        randomness_output: BytesN<32>,
        drop_commitment: BytesN<32>,
        randomness_signature: BytesN<64>,
    ) -> bool;
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
    // 5 reserved (was AlreadyCommitted)
    NotYourTurn = 6,
    InvalidTurn = 7,
    InvalidPublicInputs = 8,
    // 9 reserved (was InvalidJournalHash)
    ProofVerificationFailed = 10,
    TimeoutNotReached = 11,
    InvalidDistance = 12,
    MaxTurnsReached = 13,
    LobbyNotFound = 14,
    LobbyAlreadyExists = 15,
    SelfPlay = 16,
    RandomnessVerificationFailed = 17,
}

// ============================================================================
// Data Types
// ============================================================================

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum GameStatus {
    Created = 0,
    Active = 1,
    Completed = 2,
    Timeout = 3,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Game {
    pub player1: Address,
    pub player2: Address,
    pub player1_points: i128,
    pub player2_points: i128,
    pub drop_commitment: BytesN<32>,
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
    RandomnessVerifierId,
}

// ============================================================================
// Constants
// ============================================================================

/// 30-day TTL in ledgers (~5 seconds per ledger)
const GAME_TTL_LEDGERS: u32 = 518_400;

/// Maximum number of turns (each player gets 15 pings)
const MAX_TURNS: u32 = 30;

/// Grid dimensions for coordinate bounds checks.
const GRID_SIZE: u32 = 100;

/// Max wrapped Manhattan distance on a 100x100 toroidal grid.
const MAX_DISTANCE: u32 = 100;

/// Timeout threshold in ledgers (~50 minutes = 600 ledgers)
const TIMEOUT_LEDGERS: u32 = 600;

/// Sentinel value for "no distance recorded yet"
const NO_DISTANCE: u32 = u32::MAX;

/// Number of public inputs expected from the Noir circuit.
/// [session_id, turn, ping_x, ping_y, drop_commitment, expected_distance]
const NUM_PUBLIC_INPUTS: usize = 6;

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
        randomness_verifier_id: Address,
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
            .set(&DataKey::RandomnessVerifierId, &randomness_verifier_id);
    }

    /// Start a new game session between two players.
    ///
    /// This is the legacy multi-sig flow where both players are known up-front.
    pub fn start_game(
        env: Env,
        session_id: u32,
        player1: Address,
        player2: Address,
        player1_points: i128,
        player2_points: i128,
        randomness_output: BytesN<32>,
        drop_commitment: BytesN<32>,
        randomness_signature: BytesN<64>,
    ) -> Result<(), Error> {
        // Points must be positive.
        if player1_points <= 0 || player2_points <= 0 {
            return Err(Error::InvalidDistance);
        }

        // Prevent self-play
        if player1 == player2 {
            return Err(Error::SelfPlay);
        }

        // Reject if session slot is already in use.
        let game_key = DataKey::Game(session_id);
        if env.storage().temporary().has(&game_key) {
            return Err(Error::LobbyAlreadyExists);
        }
        let lobby_key = DataKey::Lobby(session_id);
        if env.storage().temporary().has(&lobby_key) {
            return Err(Error::LobbyAlreadyExists);
        }

        // Require auth from both players for their points
        player1.require_auth_for_args(
            vec![&env, session_id.into_val(&env), player1_points.into_val(&env)],
        );
        player2.require_auth_for_args(
            vec![&env, session_id.into_val(&env), player2_points.into_val(&env)],
        );

        // Verify randomness artifacts before starting the game.
        let randomness_verifier_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::RandomnessVerifierId)
            .expect("RandomnessVerifierId not set");
        verify_randomness(
            &env,
            &randomness_verifier_addr,
            session_id,
            &randomness_output,
            &drop_commitment,
            &randomness_signature,
        )?;

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
            drop_commitment,
            status: GameStatus::Active,
            current_turn: 0,
            whose_turn: 1,
            player1_best_distance: NO_DISTANCE,
            player2_best_distance: NO_DISTANCE,
            winner: None,
            last_action_ledger: env.ledger().sequence(),
        };

        env.storage().temporary().set(&game_key, &game);
        env.storage()
            .temporary()
            .extend_ttl(&game_key, GAME_TTL_LEDGERS, GAME_TTL_LEDGERS);

        Ok(())
    }

    /// Submit a ping result with ZK proof verification (Noir + UltraHonk).
    ///
    /// Public inputs layout (6 x 32-byte big-endian field elements):
    /// [session_id, turn, ping_x, ping_y, drop_commitment, expected_distance]
    pub fn submit_ping(
        env: Env,
        session_id: u32,
        player: Address,
        turn: u32,
        distance: u32,
        ping_x: u32,
        ping_y: u32,
        proof: Bytes,
        public_inputs: Vec<BytesN<32>>,
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
        if ping_x >= GRID_SIZE || ping_y >= GRID_SIZE {
            return Err(Error::InvalidDistance);
        }
        if distance > MAX_DISTANCE {
            return Err(Error::InvalidDistance);
        }
        if turn != game.current_turn {
            return Err(Error::InvalidTurn);
        }
        if game.current_turn >= MAX_TURNS {
            return Err(Error::MaxTurnsReached);
        }

        // Determine who is pinging and validate it's their turn
        let is_player1_turn = game.whose_turn == 1;
        let pinger = if is_player1_turn {
            if player != game.player1 {
                return Err(Error::NotYourTurn);
            }
            &game.player1
        } else {
            if player != game.player2 {
                return Err(Error::NotYourTurn);
            }
            &game.player2
        };

        // Validate public inputs count
        if public_inputs.len() != NUM_PUBLIC_INPUTS as u32 {
            return Err(Error::InvalidPublicInputs);
        }

        // Reconstruct expected public inputs from on-chain state and submitted params.
        let expected_inputs = build_public_inputs(
            &env,
            session_id,
            turn,
            ping_x,
            ping_y,
            &game.drop_commitment,
            distance,
        );

        // Compare submitted public inputs against expected values
        for i in 0..NUM_PUBLIC_INPUTS {
            let submitted = public_inputs.get(i as u32).unwrap();
            let expected = expected_inputs.get(i as u32).unwrap();
            if submitted != expected {
                return Err(Error::InvalidPublicInputs);
            }
        }

        // Verify ZK proof via cross-contract call to UltraHonk verifier
        let verifier_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::VerifierId)
            .expect("VerifierId not set");

        verify_proof(&env, &verifier_addr, &proof, &public_inputs)?;

        // Emit ping event for frontend syncing
        // Topic: ["ping", session_id]
        // Data: [player, turn, distance, ping_x, ping_y]
        env.events().publish(
            (Symbol::new(&env, "ping"), session_id),
            (player.clone(), turn, distance, ping_x, ping_y),
        );

        // Record distance and update best
        if is_player1_turn {
            if distance < game.player1_best_distance {
                game.player1_best_distance = distance;
            }
        } else if distance < game.player2_best_distance {
            game.player2_best_distance = distance;
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
        if host_points <= 0 {
            return Err(Error::InvalidDistance);
        }

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
        randomness_output: BytesN<32>,
        drop_commitment: BytesN<32>,
        randomness_signature: BytesN<64>,
    ) -> Result<(), Error> {
        if joiner_points <= 0 {
            return Err(Error::InvalidDistance);
        }

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

        // Verify randomness artifacts before starting the game.
        let randomness_verifier_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::RandomnessVerifierId)
            .expect("RandomnessVerifierId not set");
        verify_randomness(
            &env,
            &randomness_verifier_addr,
            session_id,
            &randomness_output,
            &drop_commitment,
            &randomness_signature,
        )?;

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

        // Create the game directly as active (no commit phase).
        let game = Game {
            player1: lobby.host,
            player2: joiner,
            player1_points: lobby.host_points,
            player2_points: joiner_points,
            drop_commitment,
            status: GameStatus::Active,
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

    pub fn get_randomness_verifier(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::RandomnessVerifierId)
            .expect("RandomnessVerifierId not set")
    }

    pub fn set_randomness_verifier(env: Env, new_verifier: Address) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("Admin not set");
        admin.require_auth();
        env.storage()
            .instance()
            .set(&DataKey::RandomnessVerifierId, &new_verifier);
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
// Public Inputs Construction
// ============================================================================

/// Convert a u32 value to a 32-byte big-endian field element (BytesN<32>).
/// The u32 is placed in the last 4 bytes of a 32-byte zero-padded array.
fn u32_to_field_bytes(env: &Env, value: u32) -> BytesN<32> {
    let mut buf = [0u8; 32];
    buf[28..32].copy_from_slice(&value.to_be_bytes());
    BytesN::from_array(env, &buf)
}

/// Build the expected public inputs vector from on-chain state.
/// Order must match the Noir circuit's public input declarations:
/// [session_id, turn, ping_x, ping_y, drop_commitment, expected_distance]
fn build_public_inputs(
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
// ZK Proof Verification (cross-contract call to verifier)
// ============================================================================

fn verify_proof(
    env: &Env,
    verifier_id: &Address,
    proof: &Bytes,
    public_inputs: &Vec<BytesN<32>>,
) -> Result<(), Error> {
    let mut args: Vec<Val> = Vec::new(env);
    args.push_back(proof.into_val(env));
    args.push_back(public_inputs.into_val(env));

    let result = env.try_invoke_contract::<Val, InvokeError>(
        verifier_id,
        &Symbol::new(env, "verify_proof"),
        args,
    );
    match result {
        Ok(Ok(_)) => Ok(()),
        Ok(Err(_)) | Err(_) => Err(Error::ProofVerificationFailed),
    }
}

// ============================================================================
// Randomness Verification (cross-contract call)
// ============================================================================

fn verify_randomness(
    env: &Env,
    verifier_id: &Address,
    session_id: u32,
    randomness_output: &BytesN<32>,
    drop_commitment: &BytesN<32>,
    randomness_signature: &BytesN<64>,
) -> Result<(), Error> {
    let mut args: Vec<Val> = Vec::new(env);
    args.push_back(session_id.into_val(env));
    args.push_back(randomness_output.into_val(env));
    args.push_back(drop_commitment.into_val(env));
    args.push_back(randomness_signature.into_val(env));

    let result = env.try_invoke_contract::<bool, InvokeError>(
        verifier_id,
        &Symbol::new(env, "verify_randomness"),
        args,
    );

    match result {
        Ok(Ok(true)) => Ok(()),
        Ok(Ok(false)) | Ok(Err(_)) | Err(_) => Err(Error::RandomnessVerificationFailed),
    }
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod test;
