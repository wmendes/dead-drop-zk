#![cfg_attr(target_os = "zkvm", no_std)]
#![cfg_attr(target_os = "zkvm", no_main)]

extern crate alloc;

#[cfg(target_os = "zkvm")]
mod guest {
    use risc0_zkvm::guest::env;
    use sha2::{Digest, Sha256};

    const GRID_SIZE: u32 = 100;
    const JOURNAL_LEN: usize = 84;

    pub fn main() {
        // Public inputs provided by the host.
        let session_id: u32 = env::read();
        let turn: u32 = env::read();
        let ping_x: u32 = env::read();
        let ping_y: u32 = env::read();

        // Private inputs: Player A (Player 1) half.
        let a_x: u32 = env::read();
        let a_y: u32 = env::read();
        let a_salt: [u8; 32] = env::read();
        let a_commitment: [u8; 32] = env::read();

        // Private inputs: Player B (Player 2) half.
        let b_x: u32 = env::read();
        let b_y: u32 = env::read();
        let b_salt: [u8; 32] = env::read();
        let b_commitment: [u8; 32] = env::read();

        // Bounds checks.
        if ping_x >= GRID_SIZE || ping_y >= GRID_SIZE {
            panic!("ping out of bounds");
        }
        if a_x >= GRID_SIZE || a_y >= GRID_SIZE {
            panic!("player A secret out of bounds");
        }
        if b_x >= GRID_SIZE || b_y >= GRID_SIZE {
            panic!("player B secret out of bounds");
        }

        // Verify Player A commitment: SHA256(a_x_le || a_y_le || a_salt)
        let mut hasher = Sha256::new();
        hasher.update(a_x.to_le_bytes());
        hasher.update(a_y.to_le_bytes());
        hasher.update(a_salt);
        let computed_a: [u8; 32] = hasher.finalize().into();
        if computed_a != a_commitment {
            panic!("player A commitment mismatch");
        }

        // Verify Player B commitment: SHA256(b_x_le || b_y_le || b_salt)
        let mut hasher = Sha256::new();
        hasher.update(b_x.to_le_bytes());
        hasher.update(b_y.to_le_bytes());
        hasher.update(b_salt);
        let computed_b: [u8; 32] = hasher.finalize().into();
        if computed_b != b_commitment {
            panic!("player B commitment mismatch");
        }

        // Combined drop: D = ((a_x + b_x) % GRID_SIZE, (a_y + b_y) % GRID_SIZE)
        let drop_x: u32 = (a_x + b_x) % GRID_SIZE;
        let drop_y: u32 = (a_y + b_y) % GRID_SIZE;

        // Wrapped Manhattan distance on toroidal GRID_SIZE x GRID_SIZE grid.
        let dx = abs_diff_wrapped(ping_x, drop_x, GRID_SIZE);
        let dy = abs_diff_wrapped(ping_y, drop_y, GRID_SIZE);
        let distance: u32 = dx + dy;

        let journal = encode_journal(
            session_id,
            turn,
            distance,
            ping_x,
            ping_y,
            &a_commitment,
            &b_commitment,
        );

        env::commit_slice(&journal);
    }

    fn abs_diff_wrapped(a: u32, b: u32, n: u32) -> u32 {
        let direct = a.abs_diff(b);
        let wrap = n - direct;
        if direct < wrap { direct } else { wrap }
    }

    fn encode_journal(
        session_id: u32,
        turn: u32,
        distance: u32,
        x: u32,
        y: u32,
        commitment_a: &[u8; 32],
        commitment_b: &[u8; 32],
    ) -> [u8; JOURNAL_LEN] {
        let mut out = [0u8; JOURNAL_LEN];
        out[0..4].copy_from_slice(&session_id.to_le_bytes());
        out[4..8].copy_from_slice(&turn.to_le_bytes());
        out[8..12].copy_from_slice(&distance.to_le_bytes());
        out[12..16].copy_from_slice(&x.to_le_bytes());
        out[16..20].copy_from_slice(&y.to_le_bytes());
        out[20..52].copy_from_slice(commitment_a);
        out[52..84].copy_from_slice(commitment_b);
        out
    }
}

#[cfg(target_os = "zkvm")]
risc0_zkvm::guest::entry!(guest::main);

#[cfg(not(target_os = "zkvm"))]
fn main() {}
