import { describe, expect, it } from "vitest";
import { devicePresence, dueAtForMode, replyMode, resolvePresence } from "../src/presence";

const TTL = 90_000;

describe("devicePresence", () => {
  it("keeps a fresh online heartbeat online", () => {
    expect(devicePresence("online", 1_000, 10_000, TTL)).toBe("online");
  });

  it("turns a stale online heartbeat into away", () => {
    expect(devicePresence("online", 1_000, 100_000, TTL)).toBe("away");
  });

  it("treats an explicit away as away", () => {
    expect(devicePresence("away", 1_000, 2_000, TTL)).toBe("away");
  });

  it("returns unknown for unrecognised states", () => {
    expect(devicePresence("", 1_000, 2_000, TTL)).toBe("unknown");
  });
});

describe("resolvePresence", () => {
  it("returns unknown when there are no devices", () => {
    expect(resolvePresence([], 1_000, TTL)).toBe("unknown");
  });

  it("is online when at least one device is fresh online", () => {
    expect(
      resolvePresence(
        [
          { device_id: "phone", state: "away", updated_at: 1_000 },
          { device_id: "desktop", state: "online", updated_at: 9_000 },
        ],
        10_000,
        TTL,
      ),
    ).toBe("online");
  });

  it("is away when every device is away or stale", () => {
    expect(
      resolvePresence(
        [
          { device_id: "phone", state: "away", updated_at: 1_000 },
          { device_id: "desktop", state: "online", updated_at: 1_000 },
        ],
        200_000,
        TTL,
      ),
    ).toBe("away");
  });
});

describe("replyMode", () => {
  it("lets a manual override win", () => {
    expect(replyMode("away", "online")).toBe("away");
    expect(replyMode("online", "away")).toBe("online");
  });

  it("falls back to the detected presence", () => {
    expect(replyMode(null, "away")).toBe("away");
    expect(replyMode(null, "unknown")).toBe("unknown");
  });
});

describe("dueAtForMode", () => {
  it("schedules the short away delay", () => {
    expect(dueAtForMode("away", 1_000, 15_000, 600_000)).toBe(16_000);
  });

  it("does not schedule anything while online", () => {
    expect(dueAtForMode("online", 1_000, 15_000, 600_000)).toBeNull();
  });

  it("uses the old delay when presence is unknown", () => {
    expect(dueAtForMode("unknown", 1_000, 15_000, 600_000)).toBe(601_000);
  });
});
