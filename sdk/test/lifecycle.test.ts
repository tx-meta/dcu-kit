import { describe, expect, it } from "vitest";
import { evaluateGroupLifecycle } from "../src/queries/lifecycle.js";
import type { GroupDatum } from "../src/core/types.js";

const group = (patch: Partial<GroupDatum> = {}): GroupDatum =>
  ({
    is_active: true,
    is_started: true,
    member_count: 2n,
    active_member_count: 2n,
    num_rounds: 2n,
    last_distributed_round: 0n,
    era_start_round: 0n,
    member_slots: [0n],
    start_time: 1_000n,
    interval_length: 100n,
    recommit_window: 1_000n,
    ...patch,
  }) as GroupDatum;

describe("evaluateGroupLifecycle", () => {
  it("opens recommit at a vacant next slot even with carried cover", () => {
    const result = evaluateGroupLifecycle(group(), 2n, 2_000n);
    expect(result.slotVacant).toBe(true);
    expect(result.distribute).toEqual({
      eligible: false,
      reasons: ["NEXT_SLOT_VACANT"],
    });
    expect(result.beginRecommit).toEqual({ eligible: true, reasons: [] });
  });

  it("keeps pending cover from reshuffling a full roster", () => {
    const result = evaluateGroupLifecycle(
      group({ member_slots: [1n, 0n] }),
      2n,
      2_000n,
    );
    expect(result.beginRecommit.eligible).toBe(false);
    expect(result.beginRecommit.reasons).toContain("ROTATION_CAN_CONTINUE");
    expect(result.beginRecommit.reasons).toContain("COVER_PENDING");
  });

  it("reports the recommit window before re-seal", () => {
    const result = evaluateGroupLifecycle(
      group({ is_started: false, start_time: 5_000n }),
      0n,
      5_500n,
    );
    expect(result.startGroup).toEqual({
      eligible: false,
      reasons: ["RECOMMIT_WINDOW_OPEN"],
    });
  });
});
