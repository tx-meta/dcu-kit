#!/usr/bin/env node
// Gate: the validator bytes the SDK ships must match validator-registry.json.
//
// Fails when (1) a bundled blueprint's validator fingerprints differ from the
// registry, (2) the SDK copy of a blueprint differs from its onchain/ source,
// or (3) sdk/package.json's version differs from the registry's sdkVersion.
// Any of these means a validator-hash change (or a release) is trying to ship
// undeclared — run scripts/update-validator-registry.mjs --note "..." and
// review the diff. See VERSIONING.md.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const registry = JSON.parse(
  readFileSync(join(root, "validator-registry.json"), "utf8"),
);

const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const fingerprints = (path) => {
  const bp = JSON.parse(readFileSync(join(root, path), "utf8"));
  const out = {};
  for (const v of bp.validators ?? []) {
    if (!v.title || !v.compiledCode) continue;
    out[v.title] = sha256(v.compiledCode);
  }
  return out;
};

const failures = [];

const sdkCopy = readFileSync(
  join(root, "sdk/src/core/validators/validator-registry.json"),
  "utf8",
);
if (sdkCopy !== readFileSync(join(root, "validator-registry.json"), "utf8")) {
  failures.push(
    "sdk/src/core/validators/validator-registry.json differs from validator-registry.json",
  );
}

const sdkVersion = JSON.parse(
  readFileSync(join(root, "sdk/package.json"), "utf8"),
).version;
if (registry.sdkVersion !== sdkVersion) {
  failures.push(
    `registry sdkVersion ${registry.sdkVersion} != sdk/package.json ${sdkVersion}`,
  );
}

for (const [family, fam] of Object.entries(registry.families)) {
  const bundled = fingerprints(fam.blueprint);
  const source = fingerprints(fam.onchainSource);

  for (const [title, hash] of Object.entries(bundled)) {
    if (fam.validators[title] !== hash) {
      failures.push(`${family}: '${title}' drifted from the registry`);
    }
    if (source[title] !== hash) {
      failures.push(
        `${family}: SDK copy of '${title}' differs from ${fam.onchainSource}`,
      );
    }
  }
  for (const title of Object.keys(fam.validators)) {
    if (!(title in bundled)) {
      failures.push(`${family}: '${title}' is in the registry but not the blueprint`);
    }
  }
}

if (failures.length > 0) {
  console.error("✗ validator registry check FAILED:");
  for (const f of failures) console.error("  -", f);
  console.error(
    '\nDeclare the change: node scripts/update-validator-registry.mjs --note "..."',
  );
  process.exit(1);
}
console.log("✓ validator registry matches bundled and onchain blueprints.");
