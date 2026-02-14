use dead_drop_proof_host::digest_to_bytes;
use dead_drop_proof_methods::DEAD_DROP_PROOF_GUEST_ID;
use hex::encode as hex_encode;

fn main() {
    let bytes = digest_to_bytes(DEAD_DROP_PROOF_GUEST_ID.into());
    println!("image_id: {}", hex_encode(bytes));
}
