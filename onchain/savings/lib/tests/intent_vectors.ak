use savings/types.{Current}
use savings/validation.{
  close_cycle_intent_hash, close_fund_intent_hash, datum_intent_hash,
  social_payout_intent_hash, update_fund_intent_hash, write_off_intent_hash,
}
use tests/common

// Shared with sdk/test/savingsIntent.test.ts. These literals make any
// Aiken/TypeScript encoding drift fail in both packages before deployment.

test social_payout_intent__golden() {
  social_payout_intent_hash(common.member_address(), 2_000_000) == #"5e9ffce178f6d928444b2ff5e3c08b7825315bcf1943b82697a0049c04db4016"
}

test update_fund_intent__golden() {
  update_fund_intent_hash(
    #"546573742046756e64",
    common.quorum_credential(),
    1,
    200,
    1,
    604_800_000,
    None,
  ) == #"0ac50b91a7839a2c88087efdda63cad9c855462f9f0bdd72e38b2cbba28a3aca"
}

test close_cycle_intent__golden() {
  close_cycle_intent_hash() == #"0e5751c026e543b2e8ab2eb06099daa1d1e5df47778f7787faab45cdf12fe3a8"
}

test disburse_loan_intent__golden() {
  datum_intent_hash(common.make_loan(8_000_000, 0, Current)) == #"734bb54751feff17eeffe502ca372c2e1d071ff16f8d6b817f429530b14ea3b2"
}

test write_off_intent__golden() {
  write_off_intent_hash(common.loan_name()) == #"1873e026f378b880e4da13eb49e89778e47b5f5e5669213ba6a3d9f8bdf305e2"
}

test close_fund_intent__golden() {
  close_fund_intent_hash(common.member_address()) == #"38ef6ebe9a0c08364c879a5337fa4b2f5fa60daadf1ab716153d1198ff67f7c0"
}
