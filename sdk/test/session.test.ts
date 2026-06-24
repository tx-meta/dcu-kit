import { describe, expect, it } from "vitest";
import { type LucidEvolution } from "@lucid-evolution/lucid";
import { createDcuSession } from "../src/index.js";

// createDcuSession binds lucid + settingsPolicy once. buildProtocol is pure, so this
// needs no network/emulator — the bound lucid is only read when a method is invoked.
describe("createDcuSession", () => {
  const settingsPolicy = "00".repeat(28); // a valid 28-byte policy id (56 hex)
  const session = createDcuSession({} as LucidEvolution, settingsPolicy);

  it("exposes the protocol bound to the settings policy", () => {
    expect(session.protocol).toBeDefined();
    expect(session.protocol.groupPolicyId).toMatch(/^[0-9a-f]{56}$/);
    expect(session.protocol.treasuryPolicyId).toMatch(/^[0-9a-f]{56}$/);
  });

  it("exposes every endpoint as a config-only method (no lucid arg)", () => {
    const methods = [
      "createAccount",
      "updateAccount",
      "deleteAccount",
      "createGroup",
      "updateGroup",
      "deleteGroup",
      "joinGroup",
      "startGroup",
      "distributePayout",
      "exitGroup",
      "terminateGroup",
      "terminateDefault",
      "contribute",
      "updatePayoutCredential",
      "extendGraceWindow",
      "claimPayout",
      "assignAdmin",
    ] as const;
    for (const m of methods) expect(typeof session[m]).toBe("function");
    // each bound method takes exactly its config — the lucid arg is gone
    expect(session.joinGroup.length).toBe(1);
  });
});
