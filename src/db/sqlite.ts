import BetterSqlite3 from "better-sqlite3";
import path from "path";
import fs from "fs";
import type { IDatabase, UserRow, OrderInfo } from "../types.js";

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS users (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_chat_id       TEXT    NOT NULL,
  xpr_account            TEXT    NOT NULL,
  verified               INTEGER NOT NULL DEFAULT 0,
  verification_code      TEXT,
  verification_started_at TEXT,
  created_at             TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at             TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(telegram_chat_id, xpr_account)
)`,
  `CREATE TABLE IF NOT EXISTS notification_log (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_chat_id TEXT    NOT NULL,
  trade_id         INTEGER NOT NULL,
  order_id         INTEGER NOT NULL,
  market_id        INTEGER NOT NULL,
  notified_at      TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(telegram_chat_id, trade_id, order_id)
)`,
  `CREATE TABLE IF NOT EXISTS bot_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
)`,
  `CREATE TABLE IF NOT EXISTS dex_orders (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_chat_id TEXT    NOT NULL,
  xpr_account      TEXT    NOT NULL,
  deposit_trx_id   TEXT    NOT NULL UNIQUE,
  deposit_quantity TEXT    NOT NULL,
  deposit_symbol   TEXT    NOT NULL DEFAULT '',
  deposit_amount   REAL    NOT NULL DEFAULT 0,
  received_symbol  TEXT    NOT NULL DEFAULT '',
  total_received   REAL    NOT NULL DEFAULT 0,
  fill_count       INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP
)`,
  `CREATE INDEX IF NOT EXISTS idx_users_verified ON users(verified) WHERE verified = 1`,
  `CREATE INDEX IF NOT EXISTS idx_users_account ON users(xpr_account)`,
  `CREATE INDEX IF NOT EXISTS idx_notif_lookup ON notification_log(telegram_chat_id, trade_id, order_id)`,
  `CREATE INDEX IF NOT EXISTS idx_dex_orders_account ON dex_orders(xpr_account, created_at)`,
];

export class SqliteDatabase implements IDatabase {
  private db!: BetterSqlite3.Database;
  private dbPath: string;

  constructor(dbPath?: string) {
    this.dbPath = dbPath ?? path.join(process.cwd(), "data", "bot.db");
  }

  async initialize(): Promise<void> {
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    this.db = new BetterSqlite3(this.dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    for (const stmt of SCHEMA_STATEMENTS) {
      this.db.prepare(stmt).run();
    }
  }

  async close(): Promise<void> {
    this.db?.close();
  }

  // Users

  async getVerifiedUsers(): Promise<UserRow[]> {
    const rows = this.db.prepare("SELECT * FROM users WHERE verified = 1").all() as any[];
    return rows.map(this.toUserRow);
  }

  async getAllPendingUsers(): Promise<UserRow[]> {
    const rows = this.db
      .prepare("SELECT * FROM users WHERE verified = 0 AND verification_code IS NOT NULL")
      .all() as any[];
    return rows.map(this.toUserRow);
  }

  async getUserByChatId(chatId: string): Promise<UserRow[]> {
    const rows = this.db
      .prepare("SELECT * FROM users WHERE telegram_chat_id = ?")
      .all(chatId) as any[];
    return rows.map(this.toUserRow);
  }

  async getUserByAccount(account: string): Promise<UserRow | undefined> {
    const row = this.db
      .prepare("SELECT * FROM users WHERE xpr_account = ? AND verified = 1")
      .get(account) as any | undefined;
    return row ? this.toUserRow(row) : undefined;
  }

  async getPendingVerification(chatId: string, account: string): Promise<UserRow | undefined> {
    const row = this.db
      .prepare("SELECT * FROM users WHERE telegram_chat_id = ? AND xpr_account = ? AND verified = 0")
      .get(chatId, account) as any | undefined;
    return row ? this.toUserRow(row) : undefined;
  }

  async upsertUser(chatId: string, account: string, verificationCode: string): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO users (telegram_chat_id, xpr_account, verified, verification_code, verification_started_at)
         VALUES (?, ?, 0, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(telegram_chat_id, xpr_account) DO UPDATE SET
           verification_code       = excluded.verification_code,
           verification_started_at = excluded.verification_started_at,
           verified                = 0,
           updated_at              = CURRENT_TIMESTAMP`
      )
      .run(chatId, account, verificationCode);
  }

  async verifyUser(chatId: string, account: string): Promise<void> {
    this.db
      .prepare(
        `UPDATE users
         SET verified = 1, verification_code = NULL, updated_at = CURRENT_TIMESTAMP
         WHERE telegram_chat_id = ? AND xpr_account = ?`
      )
      .run(chatId, account);
  }

  async unlinkUser(chatId: string, account: string): Promise<void> {
    this.db
      .prepare("DELETE FROM users WHERE telegram_chat_id = ? AND xpr_account = ?")
      .run(chatId, account);
  }

  // Notification dedup

  async hasNotified(chatId: string, tradeId: number, orderId: number): Promise<boolean> {
    const row = this.db
      .prepare(
        "SELECT 1 FROM notification_log WHERE telegram_chat_id = ? AND trade_id = ? AND order_id = ?"
      )
      .get(chatId, tradeId, orderId);
    return row !== undefined;
  }

  async recordNotification(
    chatId: string,
    tradeId: number,
    orderId: number,
    marketId: number
  ): Promise<void> {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO notification_log (telegram_chat_id, trade_id, order_id, market_id)
         VALUES (?, ?, ?, ?)`
      )
      .run(chatId, tradeId, orderId, marketId);
  }

  // Bot state

  async getState(key: string): Promise<string | undefined> {
    const row = this.db
      .prepare("SELECT value FROM bot_state WHERE key = ?")
      .get(key) as { value: string } | undefined;
    return row?.value;
  }

  async setState(key: string, value: string): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO bot_state (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      )
      .run(key, value);
  }

  // Order fill tracking

  async upsertOrder(order: {
    telegram_chat_id: string;
    xpr_account: string;
    deposit_trx_id: string;
    deposit_quantity: string;
    deposit_symbol: string;
    deposit_amount: number;
    received_symbol: string;
  }): Promise<boolean> {
    const result = this.db
      .prepare(
        `INSERT INTO dex_orders
           (telegram_chat_id, xpr_account, deposit_trx_id, deposit_quantity, deposit_symbol, deposit_amount, received_symbol)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(deposit_trx_id) DO NOTHING`
      )
      .run(
        order.telegram_chat_id,
        order.xpr_account,
        order.deposit_trx_id,
        order.deposit_quantity,
        order.deposit_symbol,
        order.deposit_amount,
        order.received_symbol,
      );
    return result.changes > 0;
  }

  async addFill(xpr_account: string, received_symbol: string, received_amount: number): Promise<OrderInfo | null> {
    const row = this.db
      .prepare(
        `SELECT id, deposit_quantity, deposit_symbol, deposit_amount
         FROM dex_orders
         WHERE xpr_account = ? AND deposit_symbol != ?
         ORDER BY created_at DESC
         LIMIT 1`
      )
      .get(xpr_account, received_symbol) as { id: number; deposit_quantity: string; deposit_symbol: string; deposit_amount: number } | undefined;

    if (!row) return null;

    this.db
      .prepare(
        `UPDATE dex_orders
         SET total_received = total_received + ?,
             fill_count     = fill_count + 1,
             updated_at     = CURRENT_TIMESTAMP
         WHERE id = ?`
      )
      .run(received_amount, row.id);

    const updated = this.db
      .prepare(
        `SELECT deposit_quantity, deposit_symbol, deposit_amount, total_received, fill_count
         FROM dex_orders WHERE id = ?`
      )
      .get(row.id) as any | undefined;

    if (!updated) return null;
    return {
      deposit_quantity: updated.deposit_quantity,
      deposit_symbol:   updated.deposit_symbol,
      deposit_amount:   updated.deposit_amount,
      total_received:   updated.total_received,
      fill_count:       updated.fill_count,
    };
  }

  // Helpers

  private toUserRow(row: any): UserRow {
    return {
      ...row,
      verified: row.verified === 1 || row.verified === true,
    };
  }
}
