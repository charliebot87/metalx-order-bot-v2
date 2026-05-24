export const DEX_API = 'https://dex.api.mainnet.metalx.com';

// All XMD market symbols monitored by Metal X Order Bot.
export const XMD_MARKETS = [
  'XPR_XMD', 'XBTC_XMD', 'XETH_XMD',
  'XMT_XMD', 'LOAN_XMD', 'METAL_XMD', 'XDC_XMD',
  'XDOGE_XMD', 'XHBAR_XMD', 'XLTC_XMD', 'XXRP_XMD',
  'XSOL_XMD', 'XXLM_XMD', 'XADA_XMD',
];

export interface TradeRecord {
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

export async function fetchTradesForMarket(account: string, market: string, limit = 50): Promise<TradeRecord[]> {
  const url = `${DEX_API}/dex/v1/trades/history?account=${encodeURIComponent(account)}&symbol=${encodeURIComponent(market)}&offset=0&limit=${limit}`;
  const res = await fetch(url, {
    headers: { 'Accept': 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    throw new Error(`Metal X trades API ${res.status} for ${market}`);
  }

  const data = await res.json() as { data?: TradeRecord[] };
  return data.data ?? [];
}

export async function fetchRecentTrades(account: string, afterIso: string): Promise<TradeRecord[]> {
  const allTrades: TradeRecord[] = [];

  for (const market of XMD_MARKETS) {
    try {
      const trades = await fetchTradesForMarket(account, market);
      allTrades.push(...trades.filter(t => t.block_time > afterIso));
    } catch (err) {
      console.warn(`[trades] ${market} failed for ${account}:`, (err as Error).message);
    }

    // Be polite to the API.
    await new Promise(r => setTimeout(r, 150));
  }

  const seen = new Set<string>();
  return allTrades
    .filter(t => {
      if (seen.has(t.trade_id)) return false;
      seen.add(t.trade_id);
      return true;
    })
    .sort((a, b) => a.block_time.localeCompare(b.block_time) || Number(a.trade_id) - Number(b.trade_id));
}
