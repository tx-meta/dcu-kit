import {
  createAccount,
  CreateAccountConfig,
  accountPolicyId,
  assetNameLabels,
} from "@tx-meta/dcu-kit";
import {
  makeLucid,
  cexplorerTxUrl,
  logError,
  logWalletInfo,
} from "./context.js";
import {
  loadState,
  saveState,
  accountSuffixKey,
  checkValidatorStaleness,
} from "./state.js";

async function main() {
  const { lucid, isEmulator } = await makeLucid();

  // Support ACTIVE_WALLET=USER2 to create an account for a second member.
  const activeWallet = (process.env.ACTIVE_WALLET ?? "USER1").toUpperCase();
  const walletSeed =
    process.env[`${activeWallet}_SEED`] ?? process.env.USER1_SEED;
  if (!walletSeed) throw new Error(`${activeWallet}_SEED not found in .env`);
  lucid.selectWallet.fromSeed(walletSeed);
  await logWalletInfo(lucid, activeWallet);

  checkValidatorStaleness({ accountPolicyId });

  // Check if this wallet already has an account suffix saved — skip if so.
  const state = loadState();
  const suffixKey = accountSuffixKey(activeWallet);
  const existingSuffix = state[suffixKey];
  if (existingSuffix) {
    console.log(
      `${activeWallet} already has an account in state.json (suffix: ${existingSuffix})`,
    );
    console.log(
      "Delete it from state.json manually if you want to create a new one.",
    );
    process.exit(0);
  }

  const utxos = await lucid.wallet().getUtxos();
  if (utxos.length === 0)
    throw new Error(
      `No UTxOs in ${activeWallet} wallet. Please fund it first.`,
    );

  // display_name is the raw UTF-8 string shown in the UI (ADA handle, username, etc.)
  // contact is a secondary identifier (social handle, email address, etc.)
  // Both are optional — omitting either defaults to the wallet address as a fallback.
  const displayNames: Record<string, string> = {
    ADMIN: "@admin",
    USER1: "@user1",
    USER2: "@user2",
  };
  const contacts: Record<string, string> = {
    ADMIN: "admin@web3.ada",
    USER1: "user1@web3.ada",
    USER2: "user2@web3.ada",
  };

  const config: CreateAccountConfig = {
    selected_out_ref: utxos[0],
    display_name: displayNames[activeWallet] ?? "@member",
    contact: contacts[activeWallet] ?? "member@web3.ada",
  };

  console.log("Building transaction...");
  const { tx } = await createAccount(lucid, config).unsafeRun();

  console.log("Signing and submitting...");
  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log("Transaction submitted. Hash:", txHash);
  if (!isEmulator) console.log("View on Cexplorer:", cexplorerTxUrl(txHash));

  console.log("Waiting for confirmation...");
  await lucid.awaitTx(txHash);

  const [scriptUtxo] = await lucid.utxosByOutRef([{ txHash, outputIndex: 0 }]);
  if (!scriptUtxo) throw new Error("Could not fetch minted account UTxO");
  const refKey = Object.keys(scriptUtxo.assets).find(
    (k) =>
      k.startsWith(accountPolicyId) &&
      k.slice(accountPolicyId.length).startsWith(assetNameLabels.prefix100),
  );
  if (!refKey) throw new Error("No account reference token found in output 0");
  const accountTokenSuffix = refKey.slice(
    accountPolicyId.length + assetNameLabels.prefix100.length,
  );

  saveState({ [suffixKey]: accountTokenSuffix, accountPolicyId });
  console.log(`Account created for ${activeWallet} successfully!`);
}

main().catch((e) => {
  logError(e);
  process.exit(1);
});
