use anyhow::{anyhow, Result};
use dead_drop_proof_host::{prove, PingProofInput};
use hex::encode as hex_encode;

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();

    if args.len() != 13 {
        return Err(anyhow!(
            "usage: dead-drop-proof-host <session_id> <turn> <x> <y> \
             <a_x> <a_y> <a_salt_hex> <a_commitment_hex> \
             <b_x> <b_y> <b_salt_hex> <b_commitment_hex>"
        ));
    }

    let input = PingProofInput {
        session_id: args[1].parse::<u32>()?,
        turn: args[2].parse::<u32>()?,
        x: args[3].parse::<u32>()?,
        y: args[4].parse::<u32>()?,
        a_x: args[5].parse::<u32>()?,
        a_y: args[6].parse::<u32>()?,
        a_salt: parse_hex_32(&args[7])?,
        a_commitment: parse_hex_32(&args[8])?,
        b_x: args[9].parse::<u32>()?,
        b_y: args[10].parse::<u32>()?,
        b_salt: parse_hex_32(&args[11])?,
        b_commitment: parse_hex_32(&args[12])?,
    };

    let result = prove(&input)?;

    println!("image_id: {}", hex_encode(result.image_id));
    println!("seal: {}", hex_encode(&result.seal));
    println!("journal_sha256: {}", hex_encode(result.journal_sha256));
    println!("journal.session_id: {}", result.journal.session_id);
    println!("journal.turn: {}", result.journal.turn);
    println!("journal.distance: {}", result.journal.distance);
    println!("journal.x: {}", result.journal.x);
    println!("journal.y: {}", result.journal.y);
    println!(
        "journal.commitment_a: {}",
        hex_encode(result.journal.commitment_a)
    );
    println!(
        "journal.commitment_b: {}",
        hex_encode(result.journal.commitment_b)
    );

    Ok(())
}

fn parse_hex_32(value: &str) -> Result<[u8; 32]> {
    let bytes = hex::decode(value)?;
    if bytes.len() != 32 {
        return Err(anyhow!("expected 32-byte hex value"));
    }
    let mut out = [0u8; 32];
    out.copy_from_slice(&bytes);
    Ok(out)
}
