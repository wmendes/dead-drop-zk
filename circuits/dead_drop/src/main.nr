use std::hash::poseidon2_permutation;

/// Compute Poseidon2 hash over a fixed-length array of 3 Field elements.
/// Uses the sponge construction with rate=3 and the standard IV.
/// This matches the Barretenberg/bb.js poseidon2Hash implementation.
fn poseidon2_hash_3(input: [Field; 3]) -> Field {
    let two_pow_64: Field = 18446744073709551616;
    let iv: Field = 3 * two_pow_64; // message_size << 64

    // State: [input[0], input[1], input[2], iv]
    let state: [Field; 4] = [input[0], input[1], input[2], iv];
    let permuted = poseidon2_permutation(state, 4);
    permuted[0]
}

/// Compute the wrapped distance along one axis of a toroidal grid.
fn wrapped_diff(a: u32, b: u32) -> u32 {
    let d = if a >= b { a - b } else { b - a };
    if d * 2 <= 100 { d } else { 100 - d }
}

/// Dead Drop ZK Circuit - Hidden Drop Proof
///
/// Proves that the prover knows the hidden drop witness:
///   1. Poseidon2(drop_x, drop_y, drop_salt) == expected_commitment
///   2. wrappedManhattan((ping_x,ping_y), (drop_x,drop_y)) == expected_distance
///
/// Public inputs (verified on-chain):
///   session_id, turn, ping_x, ping_y, expected_commitment, expected_distance
fn main(
    // Private inputs (kept server-side by prover)
    drop_x: u32,
    drop_y: u32,
    drop_salt: Field,

    // Public inputs (verified on-chain)
    session_id: pub u32,
    turn: pub u32,
    ping_x: pub u32,
    ping_y: pub u32,
    expected_commitment: pub Field,
    expected_distance: pub u32,
) {
    // Keep session/turn anchored in the proof transcript.
    let _ = session_id;
    let _ = turn;

    let commitment = poseidon2_hash_3([
        drop_x as Field,
        drop_y as Field,
        drop_salt,
    ]);
    assert(commitment == expected_commitment);

    let dx = wrapped_diff(ping_x, drop_x);
    let dy = wrapped_diff(ping_y, drop_y);
    assert(dx + dy == expected_distance);
}

#[test]
fn test_distance_zero_exact_match() {
    let drop_salt: Field = 0x1111;
    let commitment = poseidon2_hash_3([42 as Field, 17 as Field, drop_salt]);
    main(42, 17, drop_salt, 1, 0, 42, 17, commitment, 0);
}

#[test]
fn test_distance_nonzero() {
    // drop=(42,73), ping=(50,50)
    // dx=min(8,92)=8, dy=min(23,77)=23 => 31
    let drop_salt: Field = 0xaaaa;
    let commitment = poseidon2_hash_3([42 as Field, 73 as Field, drop_salt]);
    main(42, 73, drop_salt, 1, 0, 50, 50, commitment, 31);
}

#[test]
fn test_distance_wrap() {
    // drop=(99,99), ping=(1,1)
    // dx=min(98,2)=2, dy=min(98,2)=2 => 4
    let drop_salt: Field = 0xdead;
    let commitment = poseidon2_hash_3([99 as Field, 99 as Field, drop_salt]);
    main(99, 99, drop_salt, 7, 3, 1, 1, commitment, 4);
}
