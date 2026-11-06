import { describe, expect, it } from "vitest";
import { isWithinActiveHours, parseActiveHours } from "./active-hours.js";

describe("active hours", () => {
  const night = { start: "22:00", end: "06:00", timezone: "Europe/Amsterdam" };

  it("covers a window that crosses midnight, in the agent's time zone, through DST", () => {
    // Summer (CEST, UTC+2): 22:00 local is 20:00Z, 06:00 local is 04:00Z.
    expect(isWithinActiveHours(night, new Date("2026-07-15T19:59:00Z"))).toBe(false);
    expect(isWithinActiveHours(night, new Date("2026-07-15T20:00:00Z"))).toBe(true);
    expect(isWithinActiveHours(night, new Date("2026-07-16T03:59:00Z"))).toBe(true);
    expect(isWithinActiveHours(night, new Date("2026-07-16T04:00:00Z"))).toBe(false);
    // Winter (CET, UTC+1): the same local window is an hour later in UTC.
    expect(isWithinActiveHours(night, new Date("2026-01-15T20:30:00Z"))).toBe(false);
    expect(isWithinActiveHours(night, new Date("2026-01-15T21:00:00Z"))).toBe(true);
    expect(isWithinActiveHours(night, new Date("2026-01-16T04:30:00Z"))).toBe(true);
    expect(isWithinActiveHours(night, new Date("2026-01-16T05:00:00Z"))).toBe(false);
  });

  it("ignores a malformed window rather than guessing", () => {
    expect(parseActiveHours({ start: "22:00", end: "06:00", timezone: "Europe/Amsterdam" })).toEqual(night);
    expect(parseActiveHours({ start: "22:00", end: "6:00", timezone: "Europe/Amsterdam" })).toBeNull();
    expect(parseActiveHours({ start: "22:00", end: "06:00", timezone: "Not/A_Zone" })).toBeNull();
    expect(parseActiveHours(null)).toBeNull();
  });
});
