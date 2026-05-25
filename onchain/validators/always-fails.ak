// always_fails — reference-script deployment anchor
//
// This validator is intentionally permanent. Reference script UTxOs deployed
// at this address can never be spent (the validator always fails), so they
// remain available as .readFrom() inputs for the lifetime of the deployment.
//
// The address is deterministic: same script hash = same address on any network.
// Any transaction that provides ONLY this validator is guaranteed to fail.
validator always_fails {
  else(_) {
    fail
  }
}
