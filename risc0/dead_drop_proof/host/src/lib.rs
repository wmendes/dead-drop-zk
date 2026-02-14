use anyhow::{anyhow, Result};
use dead_drop_proof_methods::{DEAD_DROP_PROOF_GUEST_ELF, DEAD_DROP_PROOF_GUEST_ID};
use risc0_zkvm::{default_prover, ExecutorEnv, InnerReceipt, ProverOpts, Receipt};
use sha2::{Digest, Sha256};

pub const JOURNAL_LEN: usize = 84;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PingProofInput {
    pub session_id: u32,
    pub turn: u32,
    pub x: u32,
    pub y: u32,
    /// Player A (Player 1) private half.
    pub a_x: u32,
    pub a_y: u32,
    pub a_salt: [u8; 32],
    pub a_commitment: [u8; 32],
    /// Player B (Player 2) private half.
    pub b_x: u32,
    pub b_y: u32,
    pub b_salt: [u8; 32],
    pub b_commitment: [u8; 32],
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Journal {
    pub session_id: u32,
    pub turn: u32,
    pub distance: u32,
    pub x: u32,
    pub y: u32,
    pub commitment_a: [u8; 32],
    pub commitment_b: [u8; 32],
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProveResult {
    pub journal: Journal,
    pub journal_bytes: [u8; JOURNAL_LEN],
    pub seal: Vec<u8>,
    pub image_id: [u8; 32],
    pub journal_sha256: [u8; 32],
}

pub fn prove(input: &PingProofInput) -> Result<ProveResult> {
    let env = ExecutorEnv::builder()
        .write(&input.session_id)?
        .write(&input.turn)?
        .write(&input.x)?
        .write(&input.y)?
        .write(&input.a_x)?
        .write(&input.a_y)?
        .write(&input.a_salt)?
        .write(&input.a_commitment)?
        .write(&input.b_x)?
        .write(&input.b_y)?
        .write(&input.b_salt)?
        .write(&input.b_commitment)?
        .build()?;

    let prover = default_prover();
    let (opts, require_groth16) = prover_opts_from_env();
    let prove_info = prover.prove_with_opts(env, DEAD_DROP_PROOF_GUEST_ELF, &opts)?;
    prove_info.receipt.verify(DEAD_DROP_PROOF_GUEST_ID)?;

    let receipt = prove_info.receipt;
    if require_groth16 && !matches!(&receipt.inner, InnerReceipt::Groth16(_)) {
        return Err(anyhow!(
            "expected Groth16 receipt; ensure Groth16 proving is enabled"
        ));
    }

    let journal_bytes_vec = receipt.journal.bytes.clone();
    let journal_bytes: [u8; JOURNAL_LEN] = journal_bytes_vec
        .as_slice()
        .try_into()
        .map_err(|_| anyhow!("journal length mismatch"))?;

    let journal = decode_journal(&journal_bytes)?;
    let journal_sha256 = sha256(&journal_bytes);

    Ok(ProveResult {
        journal,
        journal_bytes,
        seal: receipt_seal_bytes(&receipt)?,
        image_id: digest_to_bytes(DEAD_DROP_PROOF_GUEST_ID.into()),
        journal_sha256,
    })
}

fn prover_opts_from_env() -> (ProverOpts, bool) {
    let kind = std::env::var("DEAD_DROP_PROOF_RECEIPT_KIND")
        .ok()
        .unwrap_or_else(|| "groth16".to_string())
        .to_lowercase();

    match kind.as_str() {
        "succinct" => (ProverOpts::succinct(), false),
        "composite" => (ProverOpts::composite(), false),
        "groth16" => (ProverOpts::groth16(), true),
        _ => (ProverOpts::groth16(), true),
    }
}

pub fn decode_journal(bytes: &[u8]) -> Result<Journal> {
    if bytes.len() != JOURNAL_LEN {
        return Err(anyhow!("journal length mismatch"));
    }

    let session_id = u32::from_le_bytes(bytes[0..4].try_into().unwrap());
    let turn = u32::from_le_bytes(bytes[4..8].try_into().unwrap());
    let distance = u32::from_le_bytes(bytes[8..12].try_into().unwrap());
    let x = u32::from_le_bytes(bytes[12..16].try_into().unwrap());
    let y = u32::from_le_bytes(bytes[16..20].try_into().unwrap());

    let mut commitment_a = [0u8; 32];
    commitment_a.copy_from_slice(&bytes[20..52]);

    let mut commitment_b = [0u8; 32];
    commitment_b.copy_from_slice(&bytes[52..84]);

    Ok(Journal {
        session_id,
        turn,
        distance,
        x,
        y,
        commitment_a,
        commitment_b,
    })
}

pub fn sha256(data: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(data);
    let result = hasher.finalize();
    let mut out = [0u8; 32];
    out.copy_from_slice(&result);
    out
}

pub fn digest_to_bytes(digest: risc0_zkvm::sha::Digest) -> [u8; 32] {
    let mut out = [0u8; 32];
    out.copy_from_slice(digest.as_bytes());
    out
}

pub fn receipt_seal_bytes(receipt: &Receipt) -> Result<Vec<u8>> {
    match &receipt.inner {
        InnerReceipt::Groth16(inner) => Ok(inner.seal.clone()),
        InnerReceipt::Succinct(inner) => Ok(inner.get_seal_bytes()),
        InnerReceipt::Composite(inner) => {
            if inner.assumption_receipts.is_empty() && inner.segments.len() == 1 {
                return Ok(inner.segments[0].get_seal_bytes());
            }
            let mut out = Vec::new();
            for segment in &inner.segments {
                out.extend_from_slice(&segment.get_seal_bytes());
            }
            Ok(out)
        }
        InnerReceipt::Fake(_) => Ok(Vec::new()),
        _ => Err(anyhow!("unsupported receipt type for seal extraction")),
    }
}
