import { describe, expect, it } from "vitest";
import { isWithinActiveHours, nextActiveHoursOpening, parseActiveHours } from "./active-hours.js";

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

  it("finds the next opening of the window, across midnight and DST", () => {
    // Summer: the window opens at 22:00 CEST = 20:00Z.
    expect(nextActiveHoursOpening(night, new Date("2026-07-15T12:34:56Z"))).toEqual(new Date("2026-07-15T20:00:00Z"));
    // Already open: now.
    const open = new Date("2026-07-15T23:00:00Z");
    expect(nextActiveHoursOpening(night, open)).toBe(open);
    // Just after closing (06:00 CEST = 04:00Z): tonight's opening.
    expect(nextActiveHoursOpening(night, new Date("2026-07-16T04:00:00Z"))).toEqual(new Date("2026-07-16T20:00:00Z"));
    // Winter: 22:00 CET = 21:00Z.
    expect(nextActiveHoursOpening(night, new Date("2026-01-15T10:00:00Z"))).toEqual(new Date("2026-01-15T21:00:00Z"));
    // A day window in UTC.
    expect(nextActiveHoursOpening({ start: "09:00", end: "17:00", timezone: "UTC" }, new Date("2026-07-15T17:00:00Z")))
      .toEqual(new Date("2026-07-16T09:00:00Z"));
    // Start === end is never open.
    expect(nextActiveHoursOpening({ start: "09:00", end: "09:00", timezone: "UTC" }, new Date("2026-07-15T00:00:00Z"))).toBeNull();
  });
});
