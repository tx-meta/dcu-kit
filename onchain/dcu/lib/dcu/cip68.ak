use aiken/cbor
use aiken/crypto.{blake2b_256}
use aiken/primitive/bytearray
use cardano/assets.{AssetName}
use cardano/transaction.{OutputReference}

/// (100) Reference Token Prefix
/// https://developers.cardano.org/docs/governance/cardano-improvement-proposals/cip-0068/#222-nft-standard
pub const prefix_100: ByteArray = #"000643b0"

/// (222) Non-Fungible Token Prefix
/// https://developers.cardano.org/docs/governance/cardano-improvement-proposals/cip-0068/#222-nft-standard
pub const prefix_222: ByteArray = #"000de140"

pub const prefix_length: Int = 4

/// Generates a unique, CIP-68 compatible AssetName.
/// Logic:
/// 1. serialized_ref = cbor.serialise(output_reference)
/// 2. full_hash = blake2b_256(serialized_ref)
/// 3. trimmed_hash = slice(full_hash, 0, 28) // Trims to ensure final length <= 32 bytes
/// 4. result = concat(prefix, trimmed_hash)
pub fn unique_token_name(
  output_ref: OutputReference,
  prefix: ByteArray,
) -> AssetName {
  let unique_hash = blake2b_256(cbor.serialise(output_ref))
  // CIP-68 Prefixes are 4 bytes. AssetNames max 32 bytes.
  // We must limit the unique part to 28 bytes.
  let chopped_hash = bytearray.slice(unique_hash, 0, 28)
  bytearray.concat(prefix, chopped_hash)
}

/// Converts a Reference Token Name (100) to its corresponding User Token Name (222).
/// Assumes the input is a valid CIP-68 token name (starts with 4-byte prefix).
pub fn convert_ref_to_user_token(ref_token_name: AssetName) -> AssetName {
  let unique_part = bytearray.drop(ref_token_name, prefix_length)
  bytearray.concat(prefix_222, unique_part)
}
