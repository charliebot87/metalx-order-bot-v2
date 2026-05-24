import type {
  HyperionAction,
  HyperionResponse,
  EndpointHealth,
} from './types.js';

const BACKOFF_BASE_MS = 10_000;
const BACKOFF_MAX_MS  = 300_000;
const MAX_FAILURES    = 5;
const REQUEST_TIMEOUT = 12_000;

// ─── Endpoint rotation with exponential backoff ────────────────────────────────

export class EndpointPool {
  private endpoints: EndpointHealth[];

  constructor(urls: string[]) {
    this.endpoints = urls.map(url => ({
      url,
      failures: 0,
      lastFailure: 0,
      backoffUntil: 0,
    }));
  }

  pick(): string {
    const now = Date.now();
    const available = this.endpoints.filter(e => now >= e.backoffUntil);
    const pool = available.length > 0 ? available : this.endpoints;
    pool.sort((a, b) => a.failures - b.failures);
    return pool[0].url;
  }

  markSuccess(url: string): void {
    const ep = this.endpoints.find(e => e.url === url);
    if (ep) ep.failures = Math.max(0, ep.failures - 1);
  }

  markFailure(url: string): void {
    const ep = this.endpoints.find(e => e.url === url);
    if (!ep) return;
    ep.failures++;
    ep.lastFailure = Date.now();
    const backoff = Math.min(
      BACKOFF_BASE_MS * Math.pow(2, Math.min(ep.failures - 1, MAX_FAILURES)),
      BACKOFF_MAX_MS,
    );
    ep.backoffUntil = Date.now() + backoff;
    console.warn(`[hyperion] ${url} failed ${ep.failures}x, backoff ${backoff / 1000}s`);
  }

  endpointCount(): number {
    return this.endpoints.length;
  }

  status(): string {
    return this.endpoints
      .map(e => {
        const inBackoff = Date.now() < e.backoffUntil;
        return `${e.url} (failures=${e.failures}${inBackoff ? ', in backoff' : ''})`;
      })
      .join(', ');
  }
}

// ─── HyperionClient ────────────────────────────────────────────��───────────────

export class HyperionClient {
  private pool: EndpointPool;

  constructor(endpoints: string[]) {
    this.pool = new EndpointPool(endpoints);
  }

  /**
   * Fetch transfer actions for a specific account where from=dex.
   * These are withdrawal transfers — the actual funds arriving after a fill.
   */
  async getDexWithdrawals(account: string, afterTimestamp: string, limit = 50): Promise<HyperionAction[]> {
    const params = new URLSearchParams({
      account,
      'act.name': 'transfer',
      sort: 'asc',
      after: afterTimestamp,
      limit: String(limit),
    });

    const data = await this.request<HyperionResponse>(`/v2/history/get_actions?${params}`);
    const actions = data.actions ?? [];

    // Filter to only transfers FROM dex TO this account
    return actions.filter(a => {
      const d = a.act.data as Record<string, unknown>;
      return d.from === 'dex' && d.to === account;
    });
  }

  /**
   * Fetch transfer actions for a specific account where from=account, to=dex.
   * These are deposit transfers — funds sent to the DEX to place an order.
   */
  async getDexDeposits(account: string, afterTimestamp: string, limit = 50): Promise<HyperionAction[]> {
    const params = new URLSearchParams({
      account,
      'act.name': 'transfer',
      sort: 'asc',
      after: afterTimestamp,
      limit: String(limit),
    });

    const data = await this.request<HyperionResponse>(`/v2/history/get_actions?${params}`);
    const actions = data.actions ?? [];

    return actions.filter(a => {
      const d = a.act.data as Record<string, unknown>;
      return d.from === account && d.to === 'dex';
    });
  }

  /**
   * Fetch the most recent deposit (transfer TO dex) for an account.
   * Used to correlate "Sold X → Received Y" in notifications.
   */
  async getRecentDeposit(account: string): Promise<{ quantity: string; symbol: string } | null> {
    const params = new URLSearchParams({
      account,
      'act.name': 'transfer',
      sort: 'desc',
      limit: '10',
    });

    try {
      const data = await this.request<HyperionResponse>(`/v2/history/get_actions?${params}`);
      for (const a of data.actions ?? []) {
        const d = a.act.data as Record<string, unknown>;
        if (d.from === account && d.to === 'dex' && typeof d.quantity === 'string') {
          const qty = d.quantity as string;
          const sym = qty.split(' ')[1];
          return { quantity: qty, symbol: sym ?? '' };
        }
      }
    } catch {
      // Non-critical, just skip
    }
    return null;
  }

  /**
   * Fetch recent transfers for verification (burn to token.burn).
   */
  async getTransfers(account: string, limit = 30): Promise<HyperionAction[]> {
    const params = new URLSearchParams({
      account,
      filter: 'eosio.token:transfer',
      sort: 'desc',
      limit: String(limit),
    });

    return this.request<HyperionResponse>(`/v2/history/get_actions?${params}`)
      .then(data => data.actions ?? []);
  }

  private async request<T>(path: string): Promise<T> {
    const maxRetries = this.pool.endpointCount();
    let lastErr: Error | null = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const url = this.pool.pick();
      const fullUrl = `${url}${path}`;

      try {
        const res = await fetch(fullUrl, {
          headers: { 'Accept': 'application/json' },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT),
        });

        if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
        const data = (await res.json()) as T;
        this.pool.markSuccess(url);
        return data;
      } catch (err) {
        this.pool.markFailure(url);
        lastErr = err as Error;
      }
    }

    throw lastErr ?? new Error('All endpoints failed');
  }

  endpointStatus(): string {
    return this.pool.status();
  }
}

// ─── Withdrawal data extractor ─────────────────────────────────────────────────

export interface DexWithdrawal {
  to: string;
  quantity: string;   // e.g. "1.167831 XMD"
  symbol: string;     // e.g. "XMD"
  amount: number;     // e.g. 1.167831
  contract: string;   // e.g. "xmd.token"
  trxId: string;
  timestamp: string;
  globalSeq: number;
}

export function parseWithdrawal(action: HyperionAction): DexWithdrawal | null {
  const d = action.act.data as Record<string, unknown>;
  if (d.from !== 'dex' || typeof d.quantity !== 'string') return null;

  const qty = d.quantity as string;
  const parts = qty.split(' ');
  if (parts.length !== 2) return null;

  return {
    to: String(d.to),
    quantity: qty,
    symbol: parts[1],
    amount: parseFloat(parts[0]),
    contract: action.act.account,
    trxId: action.trx_id,
    timestamp: ensureUtc(action['@timestamp']),
    globalSeq: typeof action.global_sequence === 'number' ? action.global_sequence : Number(action.global_sequence),
  };
}

// ─── Deposit data extractor ────────────────────────────────────────────────────

export interface DexDeposit {
  from: string;
  quantity: string;   // e.g. "854.0000 XPR"
  symbol: string;     // e.g. "XPR"
  amount: number;     // e.g. 854.0
  trxId: string;
  timestamp: string;
  globalSeq: number;
}

export function parseDeposit(action: HyperionAction): DexDeposit | null {
  const d = action.act.data as Record<string, unknown>;
  if (d.to !== 'dex' || typeof d.quantity !== 'string') return null;

  const qty = d.quantity as string;
  const parts = qty.split(' ');
  if (parts.length !== 2) return null;

  return {
    from: String(d.from),
    quantity: qty,
    symbol: parts[1],
    amount: parseFloat(parts[0]),
    trxId: action.trx_id,
    timestamp: ensureUtc(action['@timestamp']),
    globalSeq: typeof action.global_sequence === 'number' ? action.global_sequence : Number(action.global_sequence),
  };
}

// ─── Timestamp helpers ─────────────────────────────────��───────────────────────

function ensureUtc(iso: string): string {
  return iso.endsWith('Z') ? iso : iso + 'Z';
}

export function advanceTimestamp(iso: string): string {
  return new Date(new Date(ensureUtc(iso)).getTime() + 1).toISOString();
}

export function latestTimestamp(actions: HyperionAction[]): string | null {
  if (actions.length === 0) return null;
  const raw = actions.reduce((max, a) => (a['@timestamp'] > max ? a['@timestamp'] : max), actions[0]['@timestamp']);
  return ensureUtc(raw);
}
