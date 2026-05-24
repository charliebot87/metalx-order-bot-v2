import type { MarketInfo, OnChainMarket, TableRowsResponse } from './types.js';

const MARKET_REFRESH_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

export class MarketRegistry {
  private markets = new Map<number, MarketInfo>();
  private lastFetchAt = 0;
  private rpcEndpoints: string[];
  private currentRpcIndex = 0;

  constructor(rpcEndpoints: string[]) {
    this.rpcEndpoints = rpcEndpoints;
  }

  /** Returns market info, refreshing from chain if stale. */
  async get(marketId: number): Promise<MarketInfo | undefined> {
    await this.refreshIfStale();
    return this.markets.get(marketId);
  }

  /** Returns all markets, refreshing from chain if stale. */
  async getAll(): Promise<MarketInfo[]> {
    await this.refreshIfStale();
    return Array.from(this.markets.values());
  }

  /** Force-refresh market data from chain. Only XMD pairs are monitored. */
  async refresh(): Promise<void> {
    const raw = await this.fetchAllMarkets();
    this.markets.clear();
    for (const m of raw) {
      const parsed = parseMarket(m);
      if (!parsed) continue;
      // Only monitor XMD pairs (bid/XMD or XMD/ask)
      if (parsed.bidSymbol !== 'XMD' && parsed.askSymbol !== 'XMD') {
        continue;
      }
      this.markets.set(parsed.market_id, parsed);
    }
    this.lastFetchAt = Date.now();
    console.log(`[markets] Loaded ${this.markets.size} XMD markets`);
  }

  private async refreshIfStale(): Promise<void> {
    if (Date.now() - this.lastFetchAt > MARKET_REFRESH_INTERVAL_MS) {
      await this.refresh();
    }
  }

  private async fetchAllMarkets(): Promise<OnChainMarket[]> {
    const errors: Error[] = [];

    for (let attempt = 0; attempt < this.rpcEndpoints.length; attempt++) {
      const endpoint = this.nextRpc();
      try {
        const markets = await fetchMarketsFromEndpoint(endpoint);
        return markets;
      } catch (err) {
        errors.push(err as Error);
        console.warn(`[markets] RPC ${endpoint} failed: ${(err as Error).message}`);
      }
    }

    throw new Error(
      `All RPC endpoints failed:\n${errors.map(e => e.message).join('\n')}`
    );
  }

  private nextRpc(): string {
    const url = this.rpcEndpoints[this.currentRpcIndex % this.rpcEndpoints.length];
    this.currentRpcIndex++;
    return url;
  }
}

async function fetchMarketsFromEndpoint(rpcUrl: string): Promise<OnChainMarket[]> {
  const url = `${rpcUrl}/v1/chain/get_table_rows`;
  const body = JSON.stringify({
    code: 'dex',
    scope: 'dex',
    table: 'markets',
    limit: 200,
    json: true,
  });

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} from ${rpcUrl}`);
  }

  const data = (await res.json()) as TableRowsResponse<OnChainMarket>;
  return data.rows;
}

function parseMarket(raw: OnChainMarket): MarketInfo | null {
  try {
    // bid_token.sym format: "8,XBTC"
    const [bidPrecStr, bidSymbol] = raw.bid_token.sym.split(',');
    const bidPrecision = parseInt(bidPrecStr, 10);

    // ask_token.quantity format: "0.000000 XMD"
    const [askAmount, askSymbol] = raw.ask_token.quantity.split(' ');
    const askPrecision = (askAmount.split('.')[1] ?? '').length;

    if (!bidSymbol || !askSymbol || isNaN(bidPrecision)) return null;

    return {
      market_id: raw.market_id,
      bidSymbol,
      askSymbol,
      bidPrecision,
      askPrecision,
      bidContract: raw.bid_token.contract,
      askContract: raw.ask_token.contract,
    };
  } catch {
    console.warn(`[markets] Failed to parse market ${raw.market_id}`);
    return null;
  }
}

// ─── Price / amount formatting helpers ───────────────────────────────────────

/**
 * Formats a raw uint64 quantity (as stored on-chain) into a human-readable
 * decimal string with `precision` decimal places.
 *
 * Example: formatRaw(26260000, 8) → "0.26260000"
 */
export function formatRaw(raw: number, precision: number): string {
  if (precision === 0) return raw.toFixed(0);
  const divisor = Math.pow(10, precision);
  return (raw / divisor).toFixed(precision);
}

/**
 * Formats a number with thousands separators and up to `decimals` sig-fig
 * decimal places (trailing zeros stripped for readability, unless very small).
 *
 * Examples:
 *   formatAmount(76150.00, 6) → "76,150.00"
 *   formatAmount(0.00262600, 8) → "0.00262600"
 */
export function formatAmount(value: number, precision: number): string {
  if (value === 0) return '0';

  // For very small numbers keep full precision
  if (value < 0.01 && precision > 2) {
    return value.toFixed(precision).replace(/0+$/, '').replace(/\.$/, '');
  }

  const formatted = value.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: Math.min(precision, 8),
  });

  return formatted;
}

/** Format price from raw uint64, using ask token precision. */
export function formatPrice(rawPrice: number, market: MarketInfo): string {
  const price = rawPrice / Math.pow(10, market.askPrecision);
  return formatAmount(price, market.askPrecision);
}
