import type { Bot } from 'grammy';
import type { IDatabase, OrderInfo } from './types.js';
import type { DexWithdrawal, DexDeposit } from './hyperion.js';

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

/**
 * Build the Telegram HTML message for a DEX withdrawal notification.
 * Uses orderInfo to show cumulative fill progress when available.
 */
export function buildWithdrawalMessage(
  w: DexWithdrawal,
  account: string,
  orderInfo: OrderInfo | null,
): string {
  const lines: string[] = [];

  if (orderInfo) {
    const { deposit_quantity, deposit_symbol, deposit_amount, total_received, fill_count } = orderInfo;
    const title = fill_count > 1 ? '💰 <b>Order Fill (partial)</b>' : '💰 <b>Order Fill</b>';
    lines.push(title, '');
    lines.push(`Sold: <b>${deposit_quantity}</b>`);
    lines.push(`Fill received: <b>${w.quantity}</b>`);
    if (fill_count > 1) {
      lines.push(`Total received: <b>${total_received.toFixed(6)} ${w.symbol} (fill ${fill_count})</b>`);
    }
    if (deposit_amount > 0) {
      const isBuy = deposit_symbol === 'XMD';
      const xmdAmount = isBuy ? deposit_amount : w.amount;
      const baseAmount = isBuy ? w.amount : deposit_amount;
      const baseSymbol = isBuy ? w.symbol : deposit_symbol;
      const price = xmdAmount / baseAmount;
      lines.push(`Price: <b>${price.toFixed(6)} XMD/${baseSymbol}</b>`);
    }
  } else {
    lines.push('💰 <b>Order Fill</b>', '');
    lines.push(`Received: <b>${w.quantity}</b>`);
  }

  lines.push(`Account: <code>${account}</code>`);
  lines.push('');
  lines.push(`<a href="${METALX_URL}/dex">📊 View on Metal X</a>`);
  lines.push(`<a href="${explorerLink(w.trxId)}">🔍 View Transaction</a>`);

  return lines.join('\n');
}

/**
 * Build the Telegram HTML message for an "Order Placed" notification.
 */
export function buildOrderPlacedMessage(deposit: DexDeposit, account: string): string {
  const lines: string[] = [];
  const isBuy = deposit.symbol === 'XMD';
  lines.push('📋 <b>Order Placed</b>', '');
  lines.push(`${isBuy ? 'Buying with' : 'Selling'}: <b>${deposit.quantity}</b>`);
  lines.push(`Account: <code>${account}</code>`);
  lines.push('');
  lines.push(`<a href="${EXPLORER_URL}/${deposit.trxId}">🔍 View Transaction</a>`);
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

  async sendWithdrawal(chatId: string, w: DexWithdrawal, account: string, orderInfo: OrderInfo | null): Promise<boolean> {
    // Dedup by global_seq (unique per action)
    const already = await this.db.hasNotified(chatId, w.globalSeq, 0);
    if (already) return false;

    if (!this.rateLimiter.allow(chatId)) {
      console.warn(`[notifications] Rate limit hit for chat ${chatId}`);
      return false;
    }

    const message = buildWithdrawalMessage(w, account, orderInfo);

    try {
      console.log(`[notifications] Sending withdrawal: ${w.quantity} to ${account} (chat ${chatId})`);
      await this.bot.api.sendMessage(chatId, message, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
      });
      await this.db.recordNotification(chatId, w.globalSeq, 0, 0);
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

  async sendOrderPlaced(chatId: string, deposit: DexDeposit, account: string): Promise<void> {
    if (!this.rateLimiter.allow(chatId)) {
      console.warn(`[notifications] Rate limit hit for chat ${chatId}`);
      return;
    }
    const message = buildOrderPlacedMessage(deposit, account);
    try {
      console.log(`[notifications] Sending order placed: ${deposit.quantity} from ${account} (chat ${chatId})`);
      await this.bot.api.sendMessage(chatId, message, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
      });
    } catch (err) {
      const errMsg = (err as Error).message ?? '';
      if (errMsg.includes('403') || errMsg.includes('blocked')) {
        console.warn(`[notifications] User ${chatId} blocked bot`);
      } else {
        console.error(`[notifications] Failed to send to ${chatId}:`, errMsg);
      }
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
