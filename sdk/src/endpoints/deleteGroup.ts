import { Constr, LucidEvolution, Data, UTxO, fromText, TxSignBuilder } from "@lucid-evolution/lucid";
import { Effect } from "effect";
import { GroupDatum, GroupSpendRedeemer } from "../core/types.js";
import { DcuValidators } from "../core/validators/context.js";
import { DcuError, TransactionBuildError } from "../core/errors.js";
import { tryBuildTx } from "../core/utils.js";

export const unsignedDeleteGroupTxProgram = (
  lucid: LucidEvolution,
  groupUtxo: UTxO,
  currentDatum: GroupDatum, // Needed to preserve other fields but set is_active = false
  adminUtxo: UTxO,
  scripts: DcuValidators
): Effect.Effect<TxSignBuilder, DcuError, never> =>
  Effect.gen(function* () {
      const groupScripts = scripts.group;
      const address = groupScripts.spend.address;

      // Construct Updated Datum (Soft Delete / Deactivate)
      const deactivatedDatum: GroupDatum = {
          ...currentDatum,
          is_active: false
      };

      const redeemer = Data.to(new Constr(2, [
          fromText("GroupReference"),
          0n,
          0n,
          0n
      ]));

      const tx = yield* tryBuildTx("deleteGroup", () => lucid
        .newTx()
        .collectFrom([groupUtxo], redeemer)
        .collectFrom([adminUtxo])
        .attach.SpendingValidator(groupScripts.spend.script)
        .pay.ToContract(
            address,
            { kind: "inline", value: Data.to(deactivatedDatum, GroupDatum) },
            groupUtxo.assets
        )
        .complete()
      );

      return tx;
  });
