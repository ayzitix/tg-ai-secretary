interface SqlRow {
  [key: string]: string | number | null;
}

export interface ConnectionRow extends SqlRow {
  id: string;
  user_id: number;
  user_chat_id: number | null;
  rights: string;
  is_enabled: number;
  updated_at: number;
}

export interface ChatRow extends SqlRow {
  chat_id: number;
  title: string | null;
  username: string | null;
  paused: number;
}

export interface MessageRow extends SqlRow {
  id: number;
  chat_id: number;
  direction: string;
  text: string;
  ts: number;
}

export interface PendingRow extends SqlRow {
  chat_id: number;
  connection_id: string;
  due_at: number;
  cancelled: number;
  created_at: number;
}

export interface SettingRow extends SqlRow {
  key: string;
  value: string;
}

export interface AccountRow extends SqlRow {
  connection_id: string;
  user_id: number;
  is_enabled: number;
  updated_at: number;
}

export interface PresenceRow extends SqlRow {
  user_id: number;
  device_id: string;
  state: string;
  updated_at: number;
}

export function initAgentSchema(sql: SqlStorage): void {
  sql.exec(
    `CREATE TABLE IF NOT EXISTS connections (
       id TEXT PRIMARY KEY,
       user_id INTEGER NOT NULL,
       user_chat_id INTEGER,
       rights TEXT NOT NULL DEFAULT '{}',
       is_enabled INTEGER NOT NULL DEFAULT 1,
       updated_at INTEGER NOT NULL
     )`,
  );
  sql.exec(
    `CREATE TABLE IF NOT EXISTS chats (
       chat_id INTEGER PRIMARY KEY,
       title TEXT,
       username TEXT,
       paused INTEGER NOT NULL DEFAULT 0
     )`,
  );
  const chatColumns = sql
    .exec<{ name: string }>(`PRAGMA table_info(chats)`)
    .toArray()
    .map((column) => column.name);
  if (!chatColumns.includes("username")) {
    sql.exec(`ALTER TABLE chats ADD COLUMN username TEXT`);
  }
  sql.exec(
    `CREATE TABLE IF NOT EXISTS messages (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       chat_id INTEGER NOT NULL,
       direction TEXT NOT NULL,
       text TEXT NOT NULL,
       ts INTEGER NOT NULL
     )`,
  );
  sql.exec(
    `CREATE INDEX IF NOT EXISTS idx_messages_chat_ts ON messages (chat_id, ts)`,
  );
  sql.exec(
    `CREATE TABLE IF NOT EXISTS pending (
       chat_id INTEGER PRIMARY KEY,
       connection_id TEXT NOT NULL,
       due_at INTEGER NOT NULL,
       cancelled INTEGER NOT NULL DEFAULT 0,
       created_at INTEGER NOT NULL
     )`,
  );
  sql.exec(`CREATE INDEX IF NOT EXISTS idx_pending_due ON pending (cancelled, due_at)`);
  sql.exec(
    `CREATE TABLE IF NOT EXISTS settings (
       key TEXT PRIMARY KEY,
       value TEXT NOT NULL
     )`,
  );
}

export function initRegistrySchema(sql: SqlStorage): void {
  sql.exec(
    `CREATE TABLE IF NOT EXISTS accounts (
       connection_id TEXT PRIMARY KEY,
       user_id INTEGER NOT NULL,
       is_enabled INTEGER NOT NULL DEFAULT 1,
       updated_at INTEGER NOT NULL
     )`,
  );
  sql.exec(`CREATE INDEX IF NOT EXISTS idx_accounts_owner ON accounts (user_id)`);
  sql.exec(
    `CREATE TABLE IF NOT EXISTS presence (
       user_id INTEGER NOT NULL,
       device_id TEXT NOT NULL,
       state TEXT NOT NULL,
       updated_at INTEGER NOT NULL,
       PRIMARY KEY (user_id, device_id)
     )`,
  );
}
