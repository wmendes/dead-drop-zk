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
/// For a grid of size 100, the maximum wrapped distance on one axis is 50.
fn wrapped_diff(a: u32, b: u32) -> u32 {
    let d = if a >= b { a - b } else { b - a };
    if d * 2 <= 100 { d } else { 100 - d }
}

/// Dead Drop ZK Circuit - Nuclear Keys Responder Proof
///
/// Proves that the responder knows THEIR private coordinate and salt:
///   1. Poseidon2(responder_x, responder_y, responder_salt) == expected_commitment
///   2. wrappedManhattan((partial_dx,partial_dy), (responder_x,responder_y)) == expected_distance
///
/// partial_dx/partial_dy are provided by the pinger:
///   partial_dx = (ping_x - pinger_secret_x) mod 100
///   partial_dy = (ping_y - pinger_secret_y) mod 100
///
/// Public inputs (verified on-chain):
///   session_id, turn, partial_dx, partial_dy, expected_commitment, expected_distance
fn main(
    // Private inputs (not revealed)
    responder_x: u32,
    responder_y: u32,
    responder_salt: Field, // 254-bit field element

    // Public inputs (verified by verifier contract)
    session_id: pub u32,
    turn: pub u32,
    partial_dx: pub u32,
    partial_dy: pub u32,
    expected_commitment: pub Field, // Poseidon2(responder_x, responder_y, responder_salt)
    expected_distance: pub u32,
) {
    // Suppress unused variable warnings - these are public inputs
    // anchored in the proof but not used in circuit logic directly.
    let _ = session_id;
    let _ = turn;

    // 1. Verify responder commitment.
    let commitment = poseidon2_hash_3([
        responder_x as Field,
        responder_y as Field,
        responder_salt,
    ]);
    assert(commitment == expected_commitment);

    // 2. Verify wrapped Manhattan distance from pinger partial offsets
    // to responder secret share.
    let dx = wrapped_diff(partial_dx, responder_x);
    let dy = wrapped_diff(partial_dy, responder_y);
    assert(dx + dy == expected_distance);
}

#[test]
fn test_distance_zero_exact_match() {
    // responder=(42,17), partial=(42,17) => distance=0
    let responder_salt: Field = 0x1111;
    let commitment = poseidon2_hash_3([42 as Field, 17 as Field, responder_salt]);
    main(42, 17, responder_salt, 1, 0, 42, 17, commitment, 0);
}

#[test]
fn test_distance_nonzero() {
    // responder=(42,73), partial=(50,50)
    // dx=min(8,92)=8, dy=min(23,77)=23 => 31
    let responder_salt: Field = 0xaaaa;
    let commitment = poseidon2_hash_3([42 as Field, 73 as Field, responder_salt]);
    main(42, 73, responder_salt, 1, 0, 50, 50, commitment, 31);
}

#[test]
fn test_distance_wrap() {
    // responder=(99,99), partial=(1,1)
    // dx=min(98,2)=2, dy=min(98,2)=2 => 4
    let responder_salt: Field = 0xdead;
    let commitment = poseidon2_hash_3([99 as Field, 99 as Field, responder_salt]);
    main(99, 99, responder_salt, 7, 3, 1, 1, commitment, 4);
}

#[test]
fn test_protocol_example() {
    // pinger_secret=(42,17), responder=(73,88), ping=(15,5)
    // partial=(73,88), distance to responder=(73,88) => 0
    let responder_salt: Field = 0x5678;
    let commitment = poseidon2_hash_3([73 as Field, 88 as Field, responder_salt]);
    main(55, 77, responder_salt, 9, 12, 73, 88, commitment, 0);
}
