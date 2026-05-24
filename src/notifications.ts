import type { Bot } from 'grammy';
import type { IDatabase } from './types.js';
import type { TradeRecord } from './trades.js';

// ─── Rate limiter ──────────────────────────────────────────────────────────────

export class RateLimiter {
  private windows = new Map<string, number[]>();
  private readonly maxPerMinute: number;

  constructor(maxPerMinute: number) {
    this.maxPerMinute = maxPerMinute;
  }

  allow(chatId: string): boolean {
    const now = Date.now();
    const cutoff = now - 60_000;
    const timestamps = (this.windows.get(chatId) ?? []).filter(t => t > cutoff);
    if (timestamps.length >= this.maxPerMinute) return false;
    timestamps.push(now);
    this.windows.set(chatId, timestamps);
    return true;
  }
}

// ─── Message formatting ────────────────────────────────────────────────────────

const METALX_URL = 'https://app.metalx.com';
const EXPLORER_URL = 'https://explorer.xprnetwork.org/transaction';

function explorerLink(trxId: string): string {
  return `${EXPLORER_URL}/${trxId}`;
}

function formatNumber(value: number, decimals = 6): string {
  return value.toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: decimals,
  });
}

export function buildTradeMessage(
  trade: TradeRecord,
  account: string,
  marketName: string,
): string {
  const [bidSymbol = 'BID', askSymbol = 'ASK'] = marketName.split('/');
  const isBidUser = trade.bid_user === account;

  // Metal X trade rows are authoritative executions. Do not infer fills from
  // dex -> account transfers; those can be referral-cut withdrawals or balance
  // sweeps unrelated to the user's active order.
  const received = isBidUser
    ? `${formatNumber(trade.bid_amount)} ${bidSymbol}`
    : `${formatNumber(trade.ask_amount)} ${askSymbol}`;
  const counterAmount = isBidUser ? trade.ask_amount : trade.bid_amount;
  const counterSymbol = isBidUser ? askSymbol : bidSymbol;
  const fee = isBidUser ? trade.bid_fee : trade.ask_fee;
  const feeSymbol = isBidUser ? bidSymbol : askSymbol;

  const lines = [
    '💰 <b>Metal X Trade</b>',
    '',
    `Market: <b>${marketName}</b>`,
    `Received: <b>${received}</b>`,
    `Counter amount: <b>${formatNumber(counterAmount)} ${counterSymbol}</b>`,
    `Price: <b>${formatNumber(trade.price, 8)} XMD/${bidSymbol}</b>`,
  ];

  if (fee > 0) {
    lines.push(`Fee: <b>${formatNumber(fee)} ${feeSymbol}</b>`);
  }

  lines.push(`Account: <code>${account}</code>`);
  lines.push('');
  lines.push(`<a href="${METALX_URL}/dex">📊 View on Metal X</a>`);
  lines.push(`<a href="${explorerLink(trade.trx_id)}">🔍 View Transaction</a>`);

  return lines.join('\n');
}

// ─── NotificationService ───────────────────────────────────────────────────────

export class NotificationService {
  private rateLimiter: RateLimiter;
  private bot: Bot;
  private db: IDatabase;

  constructor(bot: Bot, db: IDatabase, maxPerMinute: number) {
    this.bot = bot;
    this.db = db;
    this.rateLimiter = new RateLimiter(maxPerMinute);
  }

  async sendTrade(chatId: string, trade: TradeRecord, account: string, marketName: string): Promise<boolean> {
    const tradeId = Number(trade.trade_id);
    const already = await this.db.hasNotified(chatId, tradeId, 0);
    if (already) return false;

    if (!this.rateLimiter.allow(chatId)) {
      console.warn(`[notifications] Rate limit hit for chat ${chatId}`);
      return false;
    }

    const message = buildTradeMessage(trade, account, marketName);

    try {
      console.log(`[notifications] Sending trade ${trade.trade_id} for ${account} (chat ${chatId})`);
      await this.bot.api.sendMessage(chatId, message, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
      });
      await this.db.recordNotification(chatId, tradeId, 0, trade.market_id);
      console.log(`[notifications] Sent successfully`);
      return true;
    } catch (err) {
      const errMsg = (err as Error).message ?? '';
      if (errMsg.includes('403') || errMsg.includes('blocked')) {
        console.warn(`[notifications] User ${chatId} blocked bot`);
      } else {
        console.error(`[notifications] Failed to send to ${chatId}:`, errMsg);
      }
      return false;
    }
  }

  async sendText(chatId: string, text: string): Promise<void> {
    try {
      await this.bot.api.sendMessage(chatId, text, { parse_mode: 'HTML' });
    } catch (err) {
      console.error(`[notifications] sendText to ${chatId} failed:`, (err as Error).message);
    }
  }
}
