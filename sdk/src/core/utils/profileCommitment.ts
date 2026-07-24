import { blake2b } from "@noble/hashes/blake2b";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils";

/** Config-safety envelope floors mirrored from onchain/rosca/lib/dcu/group.ak —
 *  keep in sync with min_recovery_threshold / min_recovery_timelock /
 *  min_recommit_window. */
export const MIN_RECOVERY_THRESHOLD = 2n;
export const MIN_RECOVERY_TIMELOCK_MS = 86_400_000n;
export const MIN_RECOMMIT_WINDOW_MS = 86_400_000n;

const DOMAIN = utf8ToBytes("dcu:profile:v1\0");
const SALT_RE = /^[0-9a-fA-F]{64}$/;

/**
 * Canonical salted profile commitment:
 * `blake2b-256(UTF8("dcu:profile:v1\0") || salt || UTF8(profile))`.
 *
 * The caller keeps the profile string and salt; only the commitment goes
 * on-chain (`AccountDatum.profile_commitment`). No Unicode normalization is
 * applied — the exact string is hashed, so the holder must retain the profile
 * byte-for-byte to reproduce the commitment.
 *
 * @param profile - exact profile string to commit to
 * @param saltHex - exactly 32 random bytes as 64 hex chars (cryptographic RNG)
 * @returns lowercase 64-char hex commitment
 *
 * @example
 * ```ts
 * import { randomBytes } from "node:crypto";
 * const salt = randomBytes(32).toString("hex"); // store alongside the profile
 * const commitment = computeProfileCommitment('{"name":"@alice"}', salt);
 * ```
 */
export const computeProfileCommitment = (
  profile: string,
  saltHex: string,
): string => {
  if (!SALT_RE.test(saltHex)) {
    throw new Error("saltHex must be exactly 32 bytes (64 hex characters)");
  }
  const salt = hexToBytes(saltHex.toLowerCase());
  const body = utf8ToBytes(profile);
  const msg = new Uint8Array(DOMAIN.length + salt.length + body.length);
  msg.set(DOMAIN, 0);
  msg.set(salt, DOMAIN.length);
  msg.set(body, DOMAIN.length + salt.length);
  return bytesToHex(blake2b(msg, { dkLen: 32 }));
};
