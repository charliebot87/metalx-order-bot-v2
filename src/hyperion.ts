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

  // Do not use dex transfer actions for fill detection. dex -> account
  // transfers can be referral-cut withdrawals or balance sweeps, not trades.
  // Fill notifications use the Metal X trades API in trades.ts instead.

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

