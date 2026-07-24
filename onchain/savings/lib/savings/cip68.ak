use aiken/cbor
use aiken/crypto.{blake2b_256}
use aiken/primitive/bytearray
use cardano/assets.{AssetName}
use cardano/transaction.{OutputReference}

/// (100) Reference Token Prefix — CIP-68.
pub const prefix_100: ByteArray = #"000643b0"

/// (222) Non-Fungible Token Prefix — CIP-68.
pub const prefix_222: ByteArray = #"000de140"

pub const prefix_length: Int = 4

/// Generates a unique, CIP-68 compatible AssetName (same algorithm as the
/// DCU account tokens and the SDK's `generateUniqueAssetName`):
/// blake2b_256(cbor(seed outref)) truncated to 28 bytes, prefixed.
pub fn unique_token_name(
  output_ref: OutputReference,
  prefix: ByteArray,
) -> AssetName {
  let unique_hash = blake2b_256(cbor.serialise(output_ref))
  // bytearray.slice is inclusive on both ends: indices 0..27 = 28 bytes.
  let chopped_hash = bytearray.slice(unique_hash, 0, 27)
  bytearray.concat(prefix, chopped_hash)
}

/// Converts a Reference Token Name (100) to its User Token Name (222).
pub fn convert_ref_to_user_token(ref_token_name: AssetName) -> AssetName {
  let unique_part = bytearray.drop(ref_token_name, prefix_length)
  bytearray.concat(prefix_222, unique_part)
}
