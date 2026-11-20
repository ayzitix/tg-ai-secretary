import type { AccountRow, PresenceRow } from "./db";
import { initRegistrySchema } from "./db";
import type { Env } from "./env";

export type RegistryRequest =
  | { type: "upsert"; connectionId: string; userId: number; isEnabled: boolean }
  | { type: "remove"; connectionId: string }
  | { type: "list" }
  | { type: "byOwner"; userId: number }
  | { type: "presenceSet"; userId: number; deviceId: string; state: string }
  | { type: "presenceGet"; userId: number };

export class Registry implements DurableObject {
  private readonly sql: SqlStorage;

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
  ) {
    this.sql = ctx.storage.sql;
    initRegistrySchema(this.sql);
  }

  async fetch(request: Request): Promise<Response> {
    let body: RegistryRequest;
    try {
      body = (await request.json()) as RegistryRequest;
    } catch {
      return json({ ok: false, error: "invalid json" }, 400);
    }

    switch (body.type) {
      case "upsert":
        this.sql.exec(
          `INSERT INTO accounts (connection_id, user_id, is_enabled, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(connection_id) DO UPDATE SET
             user_id = excluded.user_id,
             is_enabled = excluded.is_enabled,
             updated_at = excluded.updated_at`,
          body.connectionId,
          body.userId,
          body.isEnabled ? 1 : 0,
          Date.now(),
        );
        return json({ ok: true });

      case "remove":
        this.sql.exec(`DELETE FROM accounts WHERE connection_id = ?`, body.connectionId);
        return json({ ok: true });

      case "list": {
        const rows = this.sql
          .exec<AccountRow>(`SELECT * FROM accounts ORDER BY updated_at DESC LIMIT 50`)
          .toArray();
        return json({ connections: rows.map((row) => row.connection_id) });
      }

      case "byOwner": {
        const rows = this.sql
          .exec<AccountRow>(
            `SELECT * FROM accounts WHERE user_id = ? ORDER BY updated_at DESC LIMIT 10`,
            body.userId,
          )
          .toArray();
        return json({ connections: rows.map((row) => row.connection_id) });
      }

      case "presenceSet":
        this.sql.exec(
          `INSERT INTO presence (user_id, device_id, state, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(user_id, device_id) DO UPDATE SET
             state = excluded.state,
             updated_at = excluded.updated_at`,
          body.userId,
          body.deviceId,
          body.state,
          Date.now(),
        );
        return json({ ok: true });

      case "presenceGet": {
        const rows = this.sql
          .exec<PresenceRow>(`SELECT * FROM presence WHERE user_id = ?`, body.userId)
          .toArray();
        return json({
          devices: rows.map((row) => ({
            device_id: row.device_id,
            state: row.state,
            updated_at: row.updated_at,
          })),
        });
      }

      default:
        return json({ ok: false, error: "unknown request" }, 400);
    }
  }
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
