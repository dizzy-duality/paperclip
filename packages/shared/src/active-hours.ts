/** A daily window, in a named time zone, during which something may run. */
export interface ActiveHours {
  /** "HH:MM", 24-hour. */
  start: string;
  /** "HH:MM", 24-hour. Earlier than `start` means the window crosses midnight. */
  end: string;
  /** IANA time zone name, e.g. "Europe/Amsterdam". */
  timezone: string;
}

export const ACTIVE_HOURS_TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isValidTimeZone(timezone: string) {
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format();
    return true;
  } catch {
    return false;
  }
}

/** The window stored in `value`, or null when it is absent or malformed. */
export function parseActiveHours(value: unknown): ActiveHours | null {
  if (!value || typeof value !== "object") return null;
  const { start, end, timezone } = value as Record<string, unknown>;
  if (typeof start !== "string" || !ACTIVE_HOURS_TIME_RE.test(start)) return null;
  if (typeof end !== "string" || !ACTIVE_HOURS_TIME_RE.test(end)) return null;
  if (typeof timezone !== "string" || !isValidTimeZone(timezone.trim())) return null;
  return { start, end, timezone: timezone.trim() };
}

function minutesOfDay(hhmm: string) {
  const [hour, minute] = hhmm.split(":").map(Number);
  return hour! * 60 + minute!;
}

/** Whether `now` falls inside the window. Start is inclusive, end exclusive. */
export function isWithinActiveHours(hours: ActiveHours, now: Date) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: hours.timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? 0);
  const current = hour * 60 + minute;
  const start = minutesOfDay(hours.start);
  const end = minutesOfDay(hours.end);
  return start <= end ? current >= start && current < end : current >= start || current < end;
}
