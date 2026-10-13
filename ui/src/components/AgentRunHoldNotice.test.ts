import { describe, expect, it } from "vitest";
import { describeAgentRunHold } from "./AgentRunHoldNotice";

describe("describeAgentRunHold", () => {
  const now = new Date(2026, 9, 13, 21, 0);

  const time = (at: Date) => at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

  it("names the reset time, with the weekday once it is not today", () => {
    const tonight = new Date(2026, 9, 13, 23, 30);
    const tomorrow = new Date(2026, 9, 14, 13, 0);
    const weekday = tomorrow.toLocaleDateString(undefined, { weekday: "short" });

    expect(describeAgentRunHold({ reason: "provider_quota", until: tonight.toISOString(), heldRuns: 1 }, "codex", now))
      .toBe(`Held: codex is at its provider usage limit until ${time(tonight)}. 1 run waiting.`);
    expect(describeAgentRunHold({ reason: "provider_quota", until: tomorrow.toISOString(), heldRuns: 12 }, "codex", now))
      .toBe(`Held: codex is at its provider usage limit until ${weekday} ${time(tomorrow)}. 12 runs waiting.`);
    expect(describeAgentRunHold({ reason: "off_hours", until: null, heldRuns: 2 }, "codex", now))
      .toBe("Held: outside codex's active hours. 2 runs waiting.");
  });
});
