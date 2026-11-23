// Dates and durations for screens (azerbaijani-ui): DD.MM.YYYY, 24-hour time, Asia/Baku.
// Words ("dəq", "saat") live in messages/az.json; durationParts gives the key and values.

const BAKU = "Asia/Baku";

function parts(value: Date | string): Record<string, string> {
  const date = typeof value === "string" ? new Date(value) : value;
  const out: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat("en-GB", {
    timeZone: BAKU,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date)) {
    out[p.type] = p.value;
  }
  return out;
}

/** "23.11.2026". A plain date ("2026-11-23") is shown as is, without a time zone shift. */
export function formatDate(value: Date | string): string {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return value.split("-").reverse().join(".");
  }
  const p = parts(value);
  return `${p.day}.${p.month}.${p.year}`;
}

/** "23.11, 09:40": within the current year on busy screens. */
export function formatDayTime(value: Date | string): string {
  const p = parts(value);
  return `${p.day}.${p.month}, ${p.hour}:${p.minute}`;
}

/** "23.11.2026, 14:05". */
export function formatDateTime(value: Date | string): string {
  const p = parts(value);
  return `${p.day}.${p.month}.${p.year}, ${p.hour}:${p.minute}`;
}

export type DurationKey = "min" | "hours" | "hoursMin" | "days" | "daysHours";

/** 35 → min{m:35}; 320 → hoursMin{h:5,m:20}; 1680 → daysHours{d:1,h:4}. */
export function durationParts(minutes: number): {
  key: DurationKey;
  values: Record<string, number>;
} {
  const m = Math.max(0, Math.floor(minutes));
  if (m < 60) return { key: "min", values: { m } };
  if (m < 1440) {
    const h = Math.floor(m / 60);
    const rest = m % 60;
    return rest ? { key: "hoursMin", values: { h, m: rest } } : { key: "hours", values: { h } };
  }
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  return h ? { key: "daysHours", values: { d, h } } : { key: "days", values: { d } };
}
