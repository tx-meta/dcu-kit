import { describe, it, expect, vi, afterEach } from "vitest";
import {
  getGroupHistory,
  type BlockfrostConfig,
} from "../src/queries/groupHistory.js";
import { assetNameLabels } from "../src/core/utils/index.js";

// --- Real on-chain fixtures (Group A, Preprod deployment) ---

const GROUP_POLICY = "baf4af179a495f9fd4f1ec40cfd9a9969d61a777e1f15f9b8e9f9627";
const SUFFIX = "bb420f8f447386b01baf4005b183d8f39eb95ffa09f139776aa39cbf";
const REF_UNIT = `${GROUP_POLICY}${assetNameLabels.prefix100}${SUFFIX}`;

// Synthetic fixture derived from the real Group A Preprod datum (name "Kiambu Land Chama",
// contribution_fee 5_000_000). Re-encoded with Data.to(GroupCip68DatumSchema) to include
// the two Phase 0 fields (recovery_threshold=1, recovery_timelock=259_200_000) appended at
// the end of GroupDatum, and the Phase 2 Credential-typed creator_payment_credential
// (VerificationKey Constr-0 wrapper around the same 28-byte hash). Verified round-trips
// correctly with the current schema.
const REAL_DATUM_CBOR =
  "d8799fbf4b6465736372697074696f6e5836536176696e6720746f20627579206120706c6f7420696e204b69616d627520c3a2c280c294206d6f6e74686c7920726f746174696f6e446e616d65514b69616d6275204c616e64204368616d61ff01d8799f40401a004c4b4040401a001e848040401a001e8480001a004c4b401a000493e000050000d87a80d879800020d8799f581c4f98ff0132eb48622cef2482f1ecd5cfbdcc54373290ce3f0992f7f1ff8001d87980011a0f731400ffff";

const TX_CREATE = "aa".repeat(32);
const TX_UPDATE = "bb".repeat(32);
const TX_CLOSE = "cc".repeat(32);

const config: BlockfrostConfig = {
  url: "https://bf.test/api/v0",
  projectId: "test",
};

const json = (body: unknown) =>
  Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(""),
  } as Response);

const notFound = () =>
  Promise.resolve({
    ok: false,
    status: 404,
    json: () => Promise.resolve(null),
    text: () => Promise.resolve("not found"),
  } as Response);

/** A continuing-output utxos response carrying the ref token + the real datum. */
const utxosWithDatum = () => ({
  outputs: [
    {
      inline_datum: REAL_DATUM_CBOR,
      amount: [
        { unit: "lovelace", quantity: "2000000" },
        { unit: REF_UNIT, quantity: "1" },
      ],
    },
  ],
});

afterEach(() => vi.restoreAllMocks());

describe("getGroupHistory", () => {
  it("reconstructs a closed group's lifecycle and decodes each datum", async () => {
    // Blockfrost's /transactions omits the burn tx (token only in inputs) — it
    // surfaces only in /history. The reader must merge it back in.
    const txs = [
      { tx_hash: TX_CREATE, block_height: 1, block_time: 100, tx_index: 0 },
      { tx_hash: TX_UPDATE, block_height: 2, block_time: 200, tx_index: 0 },
    ];
    const history = [
      { tx_hash: TX_CREATE, action: "minted" },
      { tx_hash: TX_CLOSE, action: "burned" },
    ];

    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url.includes(`/assets/${REF_UNIT}/transactions`))
          return json(url.includes("page=1") ? txs : []);
        if (url.includes(`/assets/${REF_UNIT}/history`)) return json(history);
        // Block-info lookup for the burn tx that /transactions omitted.
        if (url.includes(`/txs/${TX_CLOSE}`) && !url.includes("/utxos"))
          return json({ block_height: 3, block_time: 300, index: 0 });
        if (url.includes("/utxos")) return json(utxosWithDatum());
        return notFound();
      }),
    );

    const result = await getGroupHistory(
      config,
      GROUP_POLICY,
      SUFFIX,
    ).unsafeRun();

    expect(result.refUnit).toBe(REF_UNIT);
    expect(result.isLive).toBe(false);
    expect(result.timeline.map((e) => e.action)).toEqual([
      "created",
      "updated",
      "closed",
    ]);

    // Datum decodes on the live steps...
    const created = result.timeline[0];
    expect(created.datum?.contribution_fee).toBe(5_000_000n);
    expect(created.metadata?.name).toBe("Kiambu Land Chama");
    expect(created.metadata?.description).toContain("Kiambu");

    // ...and is null on the closing burn (no continuing output).
    const closed = result.timeline[2];
    expect(closed.datum).toBeNull();
    expect(closed.metadata).toBeNull();
  });

  it("reports isLive=true for a group that has not been burned", async () => {
    const txs = [{ tx_hash: TX_CREATE, block_height: 1, block_time: 100 }];
    const history = [{ tx_hash: TX_CREATE, action: "minted" }];

    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url.includes("/transactions"))
          return json(url.includes("page=1") ? txs : []);
        if (url.includes("/history")) return json(history);
        if (url.includes("/utxos")) return json(utxosWithDatum());
        return notFound();
      }),
    );

    const result = await getGroupHistory(
      config,
      GROUP_POLICY,
      SUFFIX,
    ).unsafeRun();
    expect(result.isLive).toBe(true);
    expect(result.timeline).toHaveLength(1);
    expect(result.timeline[0].action).toBe("created");
  });

  it("orders same-block transactions by tx_index, not response order", async () => {
    const TX_A = "dd".repeat(32); // earlier in block 5 (tx_index 1)
    const TX_B = "ee".repeat(32); // later in block 5  (tx_index 3)
    // Returned deliberately out of position-order to prove the tiebreak sorts them.
    const txs = [
      { tx_hash: TX_CREATE, block_height: 1, block_time: 100, tx_index: 0 },
      { tx_hash: TX_B, block_height: 5, block_time: 500, tx_index: 3 },
      { tx_hash: TX_A, block_height: 5, block_time: 500, tx_index: 1 },
    ];
    const history = [{ tx_hash: TX_CREATE, action: "minted" }];

    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url.includes("/transactions"))
          return json(url.includes("page=1") ? txs : []);
        if (url.includes("/history")) return json(history);
        if (url.includes("/utxos")) return json(utxosWithDatum());
        return notFound();
      }),
    );

    const result = await getGroupHistory(
      config,
      GROUP_POLICY,
      SUFFIX,
    ).unsafeRun();
    expect(result.timeline.map((e) => e.txHash)).toEqual([
      TX_CREATE,
      TX_A,
      TX_B,
    ]);
  });

  it("returns an empty timeline for an unknown group (404)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => notFound()),
    );
    const result = await getGroupHistory(
      config,
      GROUP_POLICY,
      SUFFIX,
    ).unsafeRun();
    expect(result.timeline).toEqual([]);
    expect(result.isLive).toBe(true);
  });
});
