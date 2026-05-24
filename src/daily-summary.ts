import type { IDatabase } from './types.js';
import type { NotificationService } from './notifications.js';

const DEX_API = 'https://dex.api.mainnet.metalx.com';

// All XMD market symbols
const XMD_MARKETS = [
  'XPR_XMD', 'XBTC_XMD', 'XETH_XMD',
  'XMT_XMD', 'LOAN_XMD', 'METAL_XMD', 'XDC_XMD',
  'XDOGE_XMD', 'XHBAR_XMD', 'XLTC_XMD', 'XXRP_XMD',
  'XSOL_XMD', 'XXLM_XMD', 'XADA_XMD',
];

interface TradeRecord {
  trade_id: string;
  market_id: number;
  price: number;
  bid_user: string;
  ask_user: string;
  bid_total: number;
  bid_amount: number;
  bid_fee: number;
  ask_total: number;
  ask_amount: number;
  ask_fee: number;
  order_side: number;
  block_time: string;
  trx_id: string;
}

interface MarketApiData {
  market_id: number;
  symbol: string;
  bid_token: { code: string; precision: number };
  ask_token: { code: string; precision: number };
}

interface DailySummary {
  account: string;
  trades: TradeRecord[];
  totalBuys: number;
  totalSells: number;
  byMarket: Map<string, { buys: number; sells: number; buyVolume: number; sellVolume: number }>;
}

/**
 * Fetch all trades for an account in the last 24 hours across all XMD markets.
 */
async function fetchDailyTrades(account: string): Promise<TradeRecord[]> {
  const allTrades: TradeRecord[] = [];

  for (const market of XMD_MARKETS) {
    try {
      const url = `${DEX_API}/dex/v1/trades/history?account=${account}&symbol=${market}&offset=0&limit=100`;
      const res = await fetch(url, {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });

      if (!res.ok) continue;
      const data = await res.json() as { data: TradeRecord[] };

      const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const recentTrades = (data.data ?? []).filter(t => t.block_time >= cutoff);
      allTrades.push(...recentTrades);
    } catch {
      // Skip failed markets silently
    }

    // Small delay between market queries
    await new Promise(r => setTimeout(r, 200));
  }

  return allTrades;
}

/**
 * Build a daily summary from trades.
 */
function buildSummary(account: string, trades: TradeRecord[]): DailySummary {
  const byMarket = new Map<string, { buys: number; sells: number; buyVolume: number; sellVolume: number }>();
  let totalBuys = 0;
  let totalSells = 0;

  for (const t of trades) {
    const isBidUser = t.bid_user === account;
    const isSell = isBidUser ? t.order_side === 2 : t.order_side === 1;

    // Find market symbol from XMD_MARKETS by market_id
    // We don't have the mapping here, so use a generic label
    const marketKey = `market_${t.market_id}`;

    if (!byMarket.has(marketKey)) {
      byMarket.set(marketKey, { buys: 0, sells: 0, buyVolume: 0, sellVolume: 0 });
    }
    const m = byMarket.get(marketKey)!;

    if (isSell) {
      totalSells++;
      m.sells++;
      m.sellVolume += isBidUser ? t.ask_amount : t.bid_total;
    } else {
      totalBuys++;
      m.buys++;
      m.buyVolume += isBidUser ? t.bid_amount : t.ask_total;
    }
  }

  return { account, trades, totalBuys, totalSells, byMarket };
}

/**
 * Format the daily summary as an HTML Telegram message.
 */
function formatSummaryMessage(summary: DailySummary, marketNames: Map<number, string>): string {
  const { account, trades, totalBuys, totalSells } = summary;

  if (trades.length === 0) {
    return `📊 <b>Daily Summary for <code>${account}</code></b>\n\nNo trades in the last 24 hours.`;
  }

  const lines: string[] = [
    `📊 <b>Daily Trading Summary</b>`,
    `Account: <code>${account}</code>`,
    '',
    `Total trades: <b>${trades.length}</b> (${totalBuys} buys, ${totalSells} sells)`,
    '',
  ];

  // Group by market
  for (const [marketKey, data] of summary.byMarket) {
    const marketId = parseInt(marketKey.replace('market_', ''));
    const name = marketNames.get(marketId) ?? marketKey;
    const parts: string[] = [];
    if (data.buys > 0) parts.push(`${data.buys} buy${data.buys > 1 ? 's' : ''}`);
    if (data.sells > 0) parts.push(`${data.sells} sell${data.sells > 1 ? 's' : ''}`);
    lines.push(`• <b>${name}</b>: ${parts.join(', ')}`);
  }

  // Total fees — grouped by token symbol
  // bid_fee is denominated in bid token, ask_fee in ask token
  const feesBySymbol = new Map<string, number>();
  for (const t of trades) {
    const isBidUser = t.bid_user === account;
    const fee = isBidUser ? t.bid_fee : t.ask_fee;
    if (fee <= 0) continue;
    // Look up token symbol from marketNames
    const marketName = marketNames.get(t.market_id) ?? '';
    const [bidSym, askSym] = marketName.split('/');
    const feeSymbol = isBidUser ? (bidSym || '?') : (askSym || '?');
    feesBySymbol.set(feeSymbol, (feesBySymbol.get(feeSymbol) ?? 0) + fee);
  }
  if (feesBySymbol.size > 0) {
    lines.push('');
    const feeParts = Array.from(feesBySymbol.entries()).map(([sym, amt]) => `${amt.toFixed(4)} ${sym}`);
    lines.push(`Fees: ${feeParts.join(', ')}`);
  }

  lines.push('');
  lines.push(`<a href="https://app.metalx.com/dex">View on Metal X →</a>`);

  return lines.join('\n');
}

/**
 * Run the daily summary for all verified users.
 * Call this once per day (e.g. via setInterval or cron).
 */
export async function runDailySummary(
  db: IDatabase,
  notifications: NotificationService,
  marketNames: Map<number, string>,
): Promise<void> {
  console.log('[daily] Running daily summary...');

  const users = await db.getVerifiedUsers();
  if (users.length === 0) {
    console.log('[daily] No verified users, skipping');
    return;
  }

  for (const user of users) {
    try {
      const trades = await fetchDailyTrades(user.xpr_account);
      const summary = buildSummary(user.xpr_account, trades);
      const message = formatSummaryMessage(summary, marketNames);
      await notifications.sendText(user.telegram_chat_id, message);
      console.log(`[daily] Sent summary to ${user.xpr_account}: ${trades.length} trades`);
    } catch (err) {
      console.error(`[daily] Error for ${user.xpr_account}:`, (err as Error).message);
    }

    // Delay between users
    await new Promise(r => setTimeout(r, 500));
  }

  console.log('[daily] Summary complete');
}
