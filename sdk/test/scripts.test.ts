import { afterEach, describe, expect, it } from "vitest";
import { type UTxO } from "@lucid-evolution/lucid";
import {
  clearReferenceScripts,
  configureReferenceScripts,
  effectiveScriptRefs,
  getSessionReferenceScripts,
  resolveScriptRefs,
} from "../src/core/scripts.js";

// The resolver only inspects truthiness of treasury/group, so a minimal cast suffices.
const utxo = (tag: string): UTxO => ({ tag } as unknown as UTxO);

afterEach(() => clearReferenceScripts());

describe("resolveScriptRefs precedence", () => {
  it("falls back to inline when nothing is configured", () => {
    expect(resolveScriptRefs()).toEqual({ source: "inline", refs: {} });
  });

  it("uses the per-call override when provided", () => {
    const perCall = { treasury: utxo("t") };
    expect(resolveScriptRefs(perCall)).toEqual({
      source: "override",
      refs: perCall,
    });
  });

  it("uses the session default when no per-call refs are given", () => {
    const session = { group: utxo("g") };
    configureReferenceScripts(session);
    expect(resolveScriptRefs()).toEqual({ source: "session", refs: session });
  });

  it("per-call override beats the session default", () => {
    configureReferenceScripts({ treasury: utxo("session-t") });
    const perCall = { treasury: utxo("call-t") };
    const resolved = resolveScriptRefs(perCall);
    expect(resolved.source).toBe("override");
    expect(resolved.refs).toBe(perCall);
  });

  it("treats an empty per-call object as no override", () => {
    configureReferenceScripts({ treasury: utxo("session-t") });
    expect(resolveScriptRefs({}).source).toBe("session");
  });
});

describe("session configuration", () => {
  it("clearReferenceScripts resets to inline", () => {
    configureReferenceScripts({ treasury: utxo("t") });
    expect(getSessionReferenceScripts()).toBeDefined();
    clearReferenceScripts();
    expect(getSessionReferenceScripts()).toBeUndefined();
    expect(effectiveScriptRefs()).toEqual({});
  });

  it("effectiveScriptRefs reflects the session default for endpoints", () => {
    const session = { treasury: utxo("t"), group: utxo("g") };
    configureReferenceScripts(session);
    expect(effectiveScriptRefs()).toBe(session);
    // an explicit per-call still wins
    const perCall = { treasury: utxo("override") };
    expect(effectiveScriptRefs(perCall)).toBe(perCall);
  });
});
