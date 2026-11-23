import { describe, expect, it } from "vitest";
import { durationParts, formatDate, formatDateTime, formatDayTime } from "./index";

describe("format", () => {
  it("shows dates and times in Baku time", () => {
    // 05:40 UTC is 09:40 in Baku (UTC+4).
    const t = new Date("2026-11-23T05:40:00Z");
    expect(formatDate(t)).toBe("23.11.2026");
    expect(formatDayTime(t)).toBe("23.11, 09:40");
    expect(formatDateTime(t)).toBe("23.11.2026, 09:40");
    expect(formatDate("2026-03-14")).toBe("14.03.2026");
  });

  it("splits a duration into the largest two units", () => {
    expect(durationParts(35)).toEqual({ key: "min", values: { m: 35 } });
    expect(durationParts(300)).toEqual({ key: "hours", values: { h: 5 } });
    expect(durationParts(320)).toEqual({ key: "hoursMin", values: { h: 5, m: 20 } });
    expect(durationParts(1440)).toEqual({ key: "days", values: { d: 1 } });
    expect(durationParts(1680)).toEqual({ key: "daysHours", values: { d: 1, h: 4 } });
  });
});
