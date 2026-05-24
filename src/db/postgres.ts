import { Pool, PoolClient } from 'pg';
import type { IDatabase, UserRow, OrderInfo } from '../types.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id                      SERIAL PRIMARY KEY,
  telegram_chat_id        TEXT        NOT NULL,
  xpr_account             TEXT        NOT NULL,
  verified                BOOLEAN     NOT NULL DEFAULT FALSE,
  verification_code       TEXT,
  verification_started_at TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(telegram_chat_id, xpr_account)
);

CREATE TABLE IF NOT EXISTS notification_log (
  id               SERIAL PRIMARY KEY,
  telegram_chat_id TEXT        NOT NULL,
  trade_id         BIGINT      NOT NULL,
  order_id         BIGINT      NOT NULL,
  market_id        INTEGER     NOT NULL,
  notified_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(telegram_chat_id, trade_id, order_id)
);

CREATE TABLE IF NOT EXISTS bot_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_users_verified
  ON users(verified) WHERE verified = TRUE;

CREATE INDEX IF NOT EXISTS idx_users_account
  ON users(xpr_account);

CREATE INDEX IF NOT EXISTS idx_notif_lookup
  ON notification_log(telegram_chat_id, trade_id, order_id);

CREATE TABLE IF NOT EXISTS dex_orders (
  id               SERIAL PRIMARY KEY,
  telegram_chat_id TEXT             NOT NULL,
  xpr_account      TEXT             NOT NULL,
  deposit_trx_id   TEXT             NOT NULL UNIQUE,
  deposit_quantity TEXT             NOT NULL,
  deposit_symbol   TEXT             NOT NULL DEFAULT '',
  deposit_amount   DOUBLE PRECISION NOT NULL DEFAULT 0,
  received_symbol  TEXT             NOT NULL DEFAULT '',
  total_received   DOUBLE PRECISION NOT NULL DEFAULT 0,
  fill_count       INTEGER          NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ      NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dex_orders_account
  ON dex_orders(xpr_account, created_at);
`;

export class PostgresDatabase implements IDatabase {
  private pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({
      connectionString,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
  }

  async initialize(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query(SCHEMA);
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  // ─── Users ──────────────────────────────────────────────────────────────────

  async getVerifiedUsers(): Promise<UserRow[]> {
    const { rows } = await this.pool.query(
      'SELECT * FROM users WHERE verified = TRUE'
    );
    return rows.map(this.toUserRow);
  }

  async getAllPendingUsers(): Promise<UserRow[]> {
    const { rows } = await this.pool.query(
      'SELECT * FROM users WHERE verified = FALSE AND verification_code IS NOT NULL'
    );
    return rows.map(this.toUserRow);
  }

  async getUserByChatId(chatId: string): Promise<UserRow[]> {
    const { rows } = await this.pool.query(
      'SELECT * FROM users WHERE telegram_chat_id = $1',
      [chatId]
    );
    return rows.map(this.toUserRow);
  }

  async getUserByAccount(account: string): Promise<UserRow | undefined> {
    const { rows } = await this.pool.query(
      'SELECT * FROM users WHERE xpr_account = $1 AND verified = TRUE',
      [account]
    );
    return rows[0] ? this.toUserRow(rows[0]) : undefined;
  }

  async getPendingVerification(chatId: string, account: string): Promise<UserRow | undefined> {
    const { rows } = await this.pool.query(
      'SELECT * FROM users WHERE telegram_chat_id = $1 AND xpr_account = $2 AND verified = FALSE',
      [chatId, account]
    );
    return rows[0] ? this.toUserRow(rows[0]) : undefined;
  }

  async upsertUser(chatId: string, account: string, verificationCode: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO users (telegram_chat_id, xpr_account, verified, verification_code, verification_started_at)
       VALUES ($1, $2, FALSE, $3, NOW())
       ON CONFLICT (telegram_chat_id, xpr_account) DO UPDATE SET
         verification_code       = EXCLUDED.verification_code,
         verification_started_at = EXCLUDED.verification_started_at,
         verified                = FALSE,
         updated_at              = NOW()`,
      [chatId, account, verificationCode]
    );
  }

  async verifyUser(chatId: string, account: string): Promise<void> {
    await this.pool.query(
      `UPDATE users
       SET verified = TRUE, verification_code = NULL, updated_at = NOW()
       WHERE telegram_chat_id = $1 AND xpr_account = $2`,
      [chatId, account]
    );
  }

  async unlinkUser(chatId: string, account: string): Promise<void> {
    await this.pool.query(
      'DELETE FROM users WHERE telegram_chat_id = $1 AND xpr_account = $2',
      [chatId, account]
    );
  }

  // ─── Notification dedup ──────────────────────────────────────────────────────

  async hasNotified(chatId: string, tradeId: number, orderId: number): Promise<boolean> {
    const { rows } = await this.pool.query(
      'SELECT 1 FROM notification_log WHERE telegram_chat_id = $1 AND trade_id = $2 AND order_id = $3',
      [chatId, tradeId, orderId]
    );
    return rows.length > 0;
  }

  async recordNotification(
    chatId: string,
    tradeId: number,
    orderId: number,
    marketId: number
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO notification_log (telegram_chat_id, trade_id, order_id, market_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT DO NOTHING`,
      [chatId, tradeId, orderId, marketId]
    );
  }

  // ─── Bot state ───────────────────────────────────────────────────────────────

  async getState(key: string): Promise<string | undefined> {
    const { rows } = await this.pool.query(
      'SELECT value FROM bot_state WHERE key = $1',
      [key]
    );
    return rows[0]?.value;
  }

  async setState(key: string, value: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO bot_state (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [key, value]
    );
  }

  // ─── Order fill tracking ─────────────────────────────────────────────────────

  async upsertOrder(order: {
    telegram_chat_id: string;
    xpr_account: string;
    deposit_trx_id: string;
    deposit_quantity: string;
    deposit_symbol: string;
    deposit_amount: number;
    received_symbol: string;
  }): Promise<boolean> {
    const { rows } = await this.pool.query(
      `INSERT INTO dex_orders
         (telegram_chat_id, xpr_account, deposit_trx_id, deposit_quantity, deposit_symbol, deposit_amount, received_symbol)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (deposit_trx_id) DO NOTHING
       RETURNING id`,
      [
        order.telegram_chat_id,
        order.xpr_account,
        order.deposit_trx_id,
        order.deposit_quantity,
        order.deposit_symbol,
        order.deposit_amount,
        order.received_symbol,
      ],
    );
    return rows.length > 0;
  }

  async addFill(xpr_account: string, received_symbol: string, received_amount: number): Promise<OrderInfo | null> {
    const { rows: found } = await this.pool.query(
      `SELECT id, deposit_quantity, deposit_symbol, deposit_amount
       FROM dex_orders
       WHERE xpr_account = $1 AND deposit_symbol != $2
       ORDER BY created_at DESC
       LIMIT 1`,
      [xpr_account, received_symbol],
    );

    if (!found[0]) return null;
    const id = found[0].id;

    const { rows: updated } = await this.pool.query(
      `UPDATE dex_orders
       SET total_received = total_received + $1,
           fill_count     = fill_count + 1,
           updated_at     = NOW()
       WHERE id = $2
       RETURNING deposit_quantity, deposit_symbol, deposit_amount, total_received, fill_count`,
      [received_amount, id],
    );

    if (!updated[0]) return null;
    const r = updated[0];
    return {
      deposit_quantity: r.deposit_quantity,
      deposit_symbol:   r.deposit_symbol,
      deposit_amount:   parseFloat(r.deposit_amount),
      total_received:   parseFloat(r.total_received),
      fill_count:       r.fill_count,
    };
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  private toUserRow(row: any): UserRow {
    return {
      id: row.id,
      telegram_chat_id: row.telegram_chat_id,
      xpr_account: row.xpr_account,
      verified: Boolean(row.verified),
      verification_code: row.verification_code ?? null,
      verification_started_at: row.verification_started_at
        ? new Date(row.verification_started_at).toISOString()
        : null,
      created_at: new Date(row.created_at).toISOString(),
      updated_at: new Date(row.updated_at).toISOString(),
    };
  }
}
