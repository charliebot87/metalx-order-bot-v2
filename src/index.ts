import 'dotenv/config';
import { Bot } from 'grammy';
import { createDatabase } from './db/index.js';
import { MarketRegistry } from './markets.js';
import { HyperionClient } from './hyperion.js';
import { NotificationService } from './notifications.js';
import { setupBot } from './bot.js';
import { runDailySummary } from './daily-summary.js';
import { assertNoPrivateKeyConfiguration } from './security.js';
import { fetchRecentTrades } from './trades.js';

// ─── Config ───────────────────────────────────────────────────────────────────

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required environment variable: ${key}`);
  return val;
}

function parseEndpoints(envVar: string, defaults: string[]): string[] {
  const val = process.env[envVar];
  if (!val) return defaults;
  return val.split(',').map(s => s.trim()).filter(Boolean);
}

const BOT_TOKEN = requireEnv('TELEGRAM_BOT_TOKEN');

const HYPERION_ENDPOINTS = parseEndpoints('HYPERION_ENDPOINTS', [
  'https://proton.protonuk.io',
  'https://proton-api.eosiomadrid.io',
  'https://api-xprnetwork-main.saltant.io',
  'https://xpr-mainnet-api.bloxprod.io',
  'https://proton-hyperion.luminaryvisn.com',
  'https://proton.eosusa.io',
]);

const RPC_ENDPOINTS = parseEndpoints('RPC_ENDPOINTS', [
  'https://api.protonnz.com',
  'https://proton.greymass.com',
]);

const POLL_INTERVAL_MS  = parseInt(process.env.POLL_INTERVAL    ?? '3000', 10);
const RATE_LIMIT        = parseInt(process.env.RATE_LIMIT        ?? '10',   10);
const MAX_STALE_SECONDS = parseInt(process.env.MAX_STALE_SECONDS ?? '300',  10);

// Per-account delay between Hyperion queries to avoid rate limiting
const PER_ACCOUNT_DELAY_MS = 500;

// ─── Verification polling ──────────────────────────────────────────────────────

async function pollVerification(
  hyperion: HyperionClient,
  db: Awaited<ReturnType<typeof createDatabase>>,
  notifications: NotificationService,
): Promise<void> {
  const pending = await db.getAllPendingUsers();
  if (pending.length > 0) {
    console.log(`[verification] Checking ${pending.length} pending user(s)`);
  }

  for (const user of pending) {
    if (!user.verification_code) continue;
    const { telegram_chat_id: chatId, xpr_account: account, verification_code: code } = user;

    try {
      const transfers = await hyperion.getTransfers(account);
      const matched = transfers.find(t => {
        const d = t.act.data as Record<string, unknown>;
        return (
          t.act.name === 'transfer' &&
          d.from === account &&
          d.to === 'token.burn' &&
          typeof d.memo === 'string' &&
          d.memo.trim() === 'METALX-BOT'
        );
      });

      if (matched) {
        await db.verifyUser(chatId, account);
        await notifications.sendText(
          chatId,
          `✅ <b>Account verified!</b>\n\n<code>${account}</code> is now linked. You'll receive notifications when your Metal X orders are filled.`,
        );
        console.log(`[verification] Verified ${account} for chat ${chatId}`);
      }
    } catch (err) {
      console.warn(`[verification] Error checking ${account}:`, (err as Error).message);
    }
  }
}

// ─── Main polling loop — per-user Metal X trade monitoring ─────────────────────

async function pollTrades(
  db: Awaited<ReturnType<typeof createDatabase>>,
  notifications: NotificationService,
  markets: MarketRegistry,
): Promise<void> {
  const users = await db.getVerifiedUsers();
  if (users.length === 0) return;

  const marketNames = new Map<number, string>();
  for (const m of await markets.getAll()) {
    marketNames.set(m.market_id, `${m.bidSymbol}/${m.askSymbol}`);
  }

  for (let i = 0; i < users.length; i++) {
    const user = users[i];
    const account = user.xpr_account;
    const chatId = user.telegram_chat_id;

    const stateKey = `trade-checkpoint:${account}`;
    let checkpoint = await db.getState(stateKey);

    if (!checkpoint) {
      checkpoint = new Date().toISOString();
      await db.setState(stateKey, checkpoint);
      continue;
    }

    const age = (Date.now() - new Date(checkpoint).getTime()) / 1000;
    if (age > MAX_STALE_SECONDS) {
      const resetTo = new Date().toISOString();
      console.warn(`[poll] Trade checkpoint for ${account} is ${Math.round(age)}s old, resetting`);
      await db.setState(stateKey, resetTo);
      continue;
    }

    try {
      const trades = await fetchRecentTrades(account, checkpoint);
      for (const trade of trades) {
        const marketName = marketNames.get(trade.market_id) ?? `market ${trade.market_id}`;
        await notifications.sendTrade(chatId, trade, account, marketName);
      }

      if (trades.length > 0) {
        const latest = trades[trades.length - 1].block_time;
        await db.setState(stateKey, new Date(new Date(latest).getTime() + 1).toISOString());
      }
    } catch (err) {
      console.error(`[poll] Error checking trades for ${account}:`, (err as Error).message);
    }

    if (i < users.length - 1) {
      await new Promise(r => setTimeout(r, PER_ACCOUNT_DELAY_MS));
    }
  }
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('[boot] Starting Metal X Order Bot…');
  assertNoPrivateKeyConfiguration();

  const db = await createDatabase();
  console.log('[boot] Database initialized');

  const markets = new MarketRegistry(RPC_ENDPOINTS);
  await markets.refresh().catch(err =>
    console.warn('[boot] Market load failed:', err.message),
  );

  const hyperion = new HyperionClient(HYPERION_ENDPOINTS);
  const bot = new Bot(BOT_TOKEN);
  const notificationService = new NotificationService(bot, db, RATE_LIMIT);

  setupBot(bot, db, markets, notificationService, hyperion);

  await bot.api.setMyCommands([
    { command: 'start',   description: 'Welcome message and setup guide' },
    { command: 'link',    description: 'Link your XPR account' },
    { command: 'unlink',  description: 'Remove a linked account' },
    { command: 'status',  description: 'Show your linked accounts' },
    { command: 'markets', description: 'List all Metal X trading pairs' },
    { command: 'help',    description: 'Show all commands' },
  ]).catch(err => console.warn('[boot] setMyCommands failed:', err.message));

  const shutdown = async (signal: string) => {
    console.log(`\n[shutdown] Received ${signal}`);
    bot.stop();
    await db.close();
    process.exit(0);
  };
  process.once('SIGINT',  () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  console.log(`[boot] Starting poll loop (interval: ${POLL_INTERVAL_MS}ms)`);

  const poll = async () => {
    try {
      await pollTrades(db, notificationService, markets);
    } catch (err) {
      console.error('[poll] Unhandled error:', err);
    }

    try {
      await pollVerification(hyperion, db, notificationService);
    } catch (err) {
      console.error('[verification] Unhandled error:', err);
    }

    setTimeout(() => void poll(), POLL_INTERVAL_MS);
  };

  bot.start({
    onStart: info => console.log(`[bot] Running as @${info.username}`),
    drop_pending_updates: true,
  });

  setTimeout(() => void poll(), 1_000);

  // Daily summary — run once per day at the configured hour (default: 9 AM)
  const DAILY_HOUR = parseInt(process.env.DAILY_SUMMARY_HOUR ?? '9', 10);
  const scheduleDaily = () => {
    const now = new Date();
    const next = new Date(now);
    next.setHours(DAILY_HOUR, 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    const delay = next.getTime() - now.getTime();
    console.log(`[daily] Next summary scheduled in ${Math.round(delay / 60000)} minutes`);
    setTimeout(async () => {
      const marketNames = new Map<number, string>();
      for (const m of await markets.getAll()) {
        marketNames.set(m.market_id, `${m.bidSymbol}/${m.askSymbol}`);
      }
      await runDailySummary(db, notificationService, marketNames);
      scheduleDaily();
    }, delay);
  };
  scheduleDaily();
}

main().catch(err => {
  console.error('[fatal]', err);
  process.exit(1);
});
