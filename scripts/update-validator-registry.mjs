#!/usr/bin/env node
// Regenerate validator-registry.json from the SDK's bundled blueprints.
//
//   node scripts/update-validator-registry.mjs --note "why the hashes changed"
//
// Refreshes each family's validator fingerprints and the registry's
// sdkVersion, and appends a history entry when anything changed. The
// registry is the reviewed record tying an SDK version to the exact
// validator bytes it ships — see VERSIONING.md.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const registryPath = join(root, "validator-registry.json");

const FAMILIES = {
  rosca: { blueprint: "sdk/src/core/plutus.json", onchain: "onchain/rosca/plutus.json" },
  escrow: { blueprint: "sdk/src/escrow/plutus.json", onchain: "onchain/escrow/plutus.json" },
  savings: { blueprint: "sdk/src/savings/plutus.json", onchain: "onchain/savings/plutus.json" },
  governance: { blueprint: "sdk/src/governance/plutus.json", onchain: "onchain/governance/plutus.json" },
};

const sha256 = (s) => createHash("sha256").update(s).digest("hex");

const fingerprints = (blueprintPath) => {
  const bp = JSON.parse(readFileSync(join(root, blueprintPath), "utf8"));
  const out = {};
  for (const v of bp.validators ?? []) {
    if (!v.title || !v.compiledCode) continue;
    out[v.title] = sha256(v.compiledCode);
  }
  return out;
};

const noteIdx = process.argv.indexOf("--note");
const note = noteIdx > -1 ? process.argv[noteIdx + 1] : null;

const sdkVersion = JSON.parse(
  readFileSync(join(root, "sdk/package.json"), "utf8"),
).version;

const prev = existsSync(registryPath)
  ? JSON.parse(readFileSync(registryPath, "utf8"))
  : { registryVersion: 1, families: {}, history: [] };

const registry = {
  registryVersion: prev.registryVersion ?? 1,
  sdkVersion,
  families: {},
  history: prev.history ?? [],
};

const changed = [];
for (const [family, paths] of Object.entries(FAMILIES)) {
  const prevFam = prev.families?.[family] ?? {};
  const validators = fingerprints(paths.blueprint);
  for (const [title, hash] of Object.entries(validators)) {
    if (prevFam.validators && prevFam.validators[title] !== hash) {
      changed.push(`${family}:${title}`);
    }
  }
  registry.families[family] = {
    status: prevFam.status ?? "experimental",
    blueprint: paths.blueprint,
    onchainSource: paths.onchain,
    plutusVersion: prevFam.plutusVersion ?? "v3",
    validators,
    deployments: prevFam.deployments ?? {},
  };
}

if (changed.length > 0 || prev.sdkVersion !== sdkVersion) {
  if (!note) {
    console.error(
      "Validator fingerprints or sdkVersion changed — a --note \"...\" explaining the change is required.",
    );
    console.error("Changed:", changed.join(", ") || "(version bump only)");
    process.exit(1);
  }
  registry.history = [
    { date: new Date().toISOString().slice(0, 10), sdkVersion, changed, note },
    ...registry.history,
  ];
}

const json = JSON.stringify(registry, null, 2) + "\n";
writeFileSync(registryPath, json);
// The SDK bundles its own copy (JSON outside sdk/src can't be imported by tsc);
// check-validator-registry.mjs verifies the two stay identical.
writeFileSync(join(root, "sdk/src/core/validators/validator-registry.json"), json);
console.log(
  changed.length
    ? `Registry updated — changed: ${changed.join(", ")}`
    : "Registry refreshed — no fingerprint changes.",
);
