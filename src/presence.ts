export type Presence = "online" | "away" | "unknown";

export interface DevicePresenceRow {
  device_id: string;
  state: string;
  updated_at: number;
}

export function devicePresence(
  state: string,
  updatedAt: number,
  now: number,
  ttlMs: number,
): Presence {
  if (state === "away") return "away";
  if (state === "online") return now - updatedAt <= ttlMs ? "online" : "away";
  return "unknown";
}

export function resolvePresence(
  devices: DevicePresenceRow[],
  now: number,
  ttlMs: number,
): Presence {
  if (devices.length === 0) return "unknown";
  const resolved = devices.map((device) => devicePresence(device.state, device.updated_at, now, ttlMs));
  if (resolved.includes("online")) return "online";
  if (resolved.every((state) => state === "away")) return "away";
  return "unknown";
}

export function replyMode(override: string | null, presence: Presence): Presence {
  if (override === "away" || override === "online") return override;
  return presence;
}

export function dueAtForMode(mode: Presence, now: number, awayDelayMs: number, fallbackDelayMs: number): number | null {
  if (mode === "online") return null;
  if (mode === "away") return now + awayDelayMs;
  return now + fallbackDelayMs;
}
