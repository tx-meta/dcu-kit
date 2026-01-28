import { Constr, LucidEvolution, Data, UTxO, fromText, TxSignBuilder } from "@lucid-evolution/lucid";
import { Effect } from "effect";
import { GroupDatum, GroupSpendRedeemer } from "../core/types.js";
import { DcuValidators } from "../core/validators/context.js";

export const unsignedUpdateGroupTxProgram = (
  lucid: LucidEvolution,
  groupUtxo: UTxO,
  updatedDatum: GroupDatum,
  adminUtxo: UTxO,
  scripts: DcuValidators
): Effect.Effect<TxSignBuilder, Error, never> =>
  Effect.gen(function* () {
      const groupScripts = scripts.group;
      const address = groupScripts.spend.address;

      const redeemer = Data.to(new Constr(1, [
          fromText("GroupReference"),
          0n,
          0n,
          0n
      ]));

      const tx = yield* Effect.promise(() => lucid
        .newTx()
        .collectFrom([groupUtxo], redeemer)
        .collectFrom([adminUtxo])
        .attach.SpendingValidator(groupScripts.spend.script)
        .pay.ToContract(
            address,
            { kind: "inline", value: Data.to(updatedDatum, GroupDatum) },
            groupUtxo.assets
        )
        .complete()
      );

      return tx;
  });
