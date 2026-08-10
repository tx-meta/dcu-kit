import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import {
  computeSavingsIntentHash,
  fundStateTokenName,
} from "../src/savings/utils.js";
import type { SavingsAddress } from "../src/savings/types.js";
import { createCip68TokenNames } from "../src/core/utils/assets.js";

const QUORUM = "c0c1c2c3c4c5c6c7c8c9cacbcccdcecfc0c1c2c3c4c5c6c7c8c9cacb";
const MEMBER = "1e1d1e1d1e1d1e1d1e1d1e1d1e1d1e1d1e1d1e1d1e1d1e1d1e1d1e1d";
const destination: SavingsAddress = {
  payment_credential: { VerificationKey: [MEMBER] },
  stake_credential: null,
};

describe("savings intent Aiken/TypeScript golden vectors", () => {
  it("matches every quorum-controlled operation", async () => {
    const fundId = await Effect.runPromise(
      fundStateTokenName({
        txHash: "5eed".repeat(16),
        outputIndex: 0,
      } as never),
    );
    const memberNames = await Effect.runPromise(
      createCip68TokenNames({
        txHash: "3eed".repeat(16),
        outputIndex: 1,
      } as never),
    );
    const loanId = await Effect.runPromise(
      fundStateTokenName({
        txHash: "10a7".repeat(16),
        outputIndex: 2,
      } as never),
    );
    const loan = {
      LoanAccount: {
        fund_id: fundId,
        borrower_ref: memberNames.refTokenName,
        principal: 8_000_000n,
        outstanding: 8_000_000n,
        service_charge: 400_000n,
        charge_paid: 0n,
        due: 1_750_000_000_000n,
        grace: 604_800_000n,
        status: "Current" as const,
      },
    };

    expect(
      computeSavingsIntentHash({
        SocialPayoutIntent: { destination, amount: 2_000_000n },
      }),
    ).toBe("5e9ffce178f6d928444b2ff5e3c08b7825315bcf1943b82697a0049c04db4016");
    expect(
      computeSavingsIntentHash({
        UpdateFundIntent: {
          title: "546573742046756e64",
          quorum: { VerificationKey: [QUORUM] },
          min_shares_per_deposit: 1n,
          max_shares_per_deposit: 200n,
          max_loan_multiple: 1n,
          loan_grace: 604_800_000n,
          cycle_end: null,
        },
      }),
    ).toBe("0ac50b91a7839a2c88087efdda63cad9c855462f9f0bdd72e38b2cbba28a3aca");
    expect(computeSavingsIntentHash({ CloseCycleIntent: {} })).toBe(
      "0e5751c026e543b2e8ab2eb06099daa1d1e5df47778f7787faab45cdf12fe3a8",
    );
    expect(computeSavingsIntentHash({ DisburseLoanIntent: { loan } })).toBe(
      "734bb54751feff17eeffe502ca372c2e1d071ff16f8d6b817f429530b14ea3b2",
    );
    expect(
      computeSavingsIntentHash({ WriteOffLoanIntent: { loan_id: loanId } }),
    ).toBe("1873e026f378b880e4da13eb49e89778e47b5f5e5669213ba6a3d9f8bdf305e2");
    expect(computeSavingsIntentHash({ CloseFundIntent: { destination } })).toBe(
      "38ef6ebe9a0c08364c879a5337fa4b2f5fa60daadf1ab716153d1198ff67f7c0",
    );
  });
});
