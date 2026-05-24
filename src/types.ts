// ─── Market types ─────────────────────────────────────────────────────────────

export interface OnChainMarket {
  market_id: number;
  bid_token: {
    sym: string;
    contract: string;
  };
  ask_token: {
    quantity: string;
    contract: string;
  };
}

export interface MarketInfo {
  market_id: number;
  bidSymbol: string;
  askSymbol: string;
  bidPrecision: number;
  askPrecision: number;
  bidContract: string;
  askContract: string;
}

// ─── Hyperion action types ────────────────────────────────────────────────────

export interface HyperionAction {
  global_sequence: number;
  "@timestamp": string;
  trx_id: string;
  act: {
    account: string;
    name: string;
    data: Record<string, unknown>;
  };
}

export interface HyperionResponse {
  actions: HyperionAction[];
  total: { value: number; relation: string };
}

export interface TableRowsResponse<T> {
  rows: T[];
  more: boolean;
  next_key: string;
}

// ─── Order tracking ───────────────────────────────────────────────────────────

export interface OrderInfo {
  deposit_quantity: string;
  deposit_symbol: string;
  deposit_amount: number;
  total_received: number;
  fill_count: number;
}

// ─── Database row types ───────────────────────────────────────────────────────

export interface UserRow {
  id: number;
  telegram_chat_id: string;
  xpr_account: string;
  verified: boolean;
  verification_code: string | null;
  verification_started_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface NotificationLogRow {
  id: number;
  telegram_chat_id: string;
  trade_id: number;
  order_id: number;
  market_id: number;
  notified_at: string;
}

// ─── Database abstraction ─────────────────────────────────────────────────────

export interface IDatabase {
  initialize(): Promise<void>;
  close(): Promise<void>;

  // Users
  getVerifiedUsers(): Promise<UserRow[]>;
  getAllPendingUsers(): Promise<UserRow[]>;
  getUserByChatId(chatId: string): Promise<UserRow[]>;
  getUserByAccount(account: string): Promise<UserRow | undefined>;
  getPendingVerification(chatId: string, account: string): Promise<UserRow | undefined>;
  upsertUser(chatId: string, account: string, verificationCode: string): Promise<void>;
  verifyUser(chatId: string, account: string): Promise<void>;
  unlinkUser(chatId: string, account: string): Promise<void>;

  // Notification dedup
  hasNotified(chatId: string, tradeId: number, orderId: number): Promise<boolean>;
  recordNotification(chatId: string, tradeId: number, orderId: number, marketId: number): Promise<void>;

  // Bot state (key-value)
  getState(key: string): Promise<string | undefined>;
  setState(key: string, value: string): Promise<void>;

  // Order fill tracking
  upsertOrder(order: {
    telegram_chat_id: string;
    xpr_account: string;
    deposit_trx_id: string;
    deposit_quantity: string;
    deposit_symbol: string;
    deposit_amount: number;
    received_symbol: string;
  }): Promise<boolean>;

  addFill(xpr_account: string, received_symbol: string, received_amount: number): Promise<OrderInfo | null>;
}

// ─── Endpoint health tracking ─────────────────────────────────────────────────

export interface EndpointHealth {
  url: string;
  failures: number;
  lastFailure: number;
  backoffUntil: number;
}
