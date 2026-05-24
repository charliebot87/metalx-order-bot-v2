# Metal X Order Bot 🔔

A self-hosted Telegram bot that sends you real-time notifications when your orders fill on [Metal X](https://metalx.com) — the decentralized exchange on XPR Network.

- ✅ Real-time fill notifications (Sold X → Received Y)
- ✅ Daily trading summary with trade counts and fees
- ✅ All XMD trading pairs on Metal X
- ✅ Secure read-only account verification (burn to `token.burn`)
- ✅ No private keys, no signing libraries, no transaction authority inside the bot
- ✅ SQLite (local) or PostgreSQL (Railway/cloud)
- ✅ 6 Hyperion endpoints with automatic rotation and failover
- ✅ Notification dedup — no spam on restarts
- ✅ Rate limiting — max 10 notifications/minute per user

## What It Looks Like

**Trade fill:**
```
💰 Metal X Trade

Market: XPR/XMD
Received: 1.9924 XMD
Counter amount: 854 XPR
Price: 0.002333 XMD/XPR
Account: charliebot

📊 View on Metal X
🔍 View Transaction
```

**Daily summary (9 AM):**
```
📊 Daily Trading Summary
Account: charliebot

Total trades: 10 (3 buys, 7 sells)

• XPR/XMD: 7 sells
• XBTC/XMD: 3 buys

Fees: 4.7500 XPR, 0.0035 XBTC

View on Metal X →
```

---

## Quick Start

### 1. Create a Telegram Bot

1. Open Telegram and search for [@BotFather](https://t.me/botfather)
2. Send `/newbot`
3. Choose a name (e.g. "My Metal X Notifications")
4. Choose a username (e.g. `my_metalx_bot`)
5. **Copy the bot token** — you'll need it next

### 2. Clone & Configure

```bash
git clone https://github.com/charliebot87/metalx-order-bot-v2.git
cd metalx-order-bot-v2
cp .env.example .env
```

Edit `.env` and add your bot token:
```env
TELEGRAM_BOT_TOKEN=your_bot_token_here
```

That's it for local use. SQLite is the default — no database setup needed.

### 3. Install & Run

```bash
npm install
npm run build
npm start
```

Or for development with auto-reload:
```bash
npm run dev
```

### 4. Link Your Account

1. Open your bot in Telegram
2. Send `/link youraccount` (your XPR account name)
3. The bot tells you to send any amount of XPR to `token.burn` with memo `METALX-BOT`
4. Send `0.0001 XPR` to `token.burn` with memo `METALX-BOT` using [WebAuth Wallet](https://webauth.com)
5. The bot detects the burn and verifies your account automatically
6. You're done — fill notifications are now live

---

## Deploy to Railway

[Railway](https://railway.app) is the easiest way to run this 24/7 in the cloud.

### Option A: Railway Dashboard (no CLI needed)

1. Fork this repo to your GitHub account
2. Go to [railway.app](https://railway.app) and sign in with GitHub
3. Click **New Project → Deploy from GitHub repo**
4. Select your forked repo
5. Railway will auto-detect the Dockerfile
6. Add environment variables:
   - `TELEGRAM_BOT_TOKEN` = your bot token
   - `DATABASE_URL` = *(add a PostgreSQL plugin from Railway's dashboard, it auto-sets this)*
7. Click **Deploy**

### Option B: Railway CLI

```bash
# Install Railway CLI
npm install -g @railway/cli

# Login
railway login

# Create project
railway init

# Add PostgreSQL
railway add --plugin postgresql

# Set bot token
railway variables set TELEGRAM_BOT_TOKEN=your_bot_token_here

# Deploy
railway up
```

### Railway with PostgreSQL

When you add a PostgreSQL plugin on Railway, it automatically sets `DATABASE_URL`. The bot detects this and uses PostgreSQL instead of SQLite. No code changes needed.

### Railway with SQLite

If you don't add PostgreSQL, the bot uses SQLite by default. Note: Railway's filesystem is ephemeral — your SQLite data resets on each deploy. For persistent data, either:
- Use PostgreSQL (recommended)
- Mount a Railway volume at `/app/data`

---

## Configuration

All configuration is via environment variables:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `TELEGRAM_BOT_TOKEN` | **Yes** | — | Bot token from @BotFather |
| `DATABASE_URL` | No | *(SQLite)* | PostgreSQL connection string. If set, uses PostgreSQL. |
| `HYPERION_ENDPOINTS` | No | 6 public endpoints | Comma-separated Hyperion API endpoints (rotated on failure) |
| `RPC_ENDPOINTS` | No | `api.protonnz.com, proton.greymass.com` | Comma-separated RPC endpoints for on-chain reads |
| `POLL_INTERVAL` | No | `3000` | Milliseconds between poll cycles |
| `RATE_LIMIT` | No | `10` | Max notifications per user per minute |
| `MAX_STALE_SECONDS` | No | `300` | If the bot was offline longer than this, skip old events instead of replaying them |
| `DAILY_SUMMARY_HOUR` | No | `9` | Hour (0-23) to send daily trading summary |

---

## How Verification Works

To prevent anyone from subscribing to someone else's orders, the bot requires **on-chain proof of ownership**:

1. User sends `/link myaccount` to the bot
2. Bot tells user to send any amount of XPR to `token.burn` with memo `METALX-BOT`
3. User sends **0.0001 XPR** (or any amount) from `myaccount` to `token.burn` with memo `METALX-BOT`
4. Bot polls Hyperion for a transfer matching account + recipient + memo
5. On match → account is verified and linked

This proves the user controls the account without ever giving the bot custody or signing authority. The memo is always `METALX-BOT` — you only need to do this once per account. The XPR is sent to [`token.burn`](https://explorer.xprnetwork.org/account/token.burn) — a tiny burn to verify ownership.

---

## Supported Markets

| # | Market | Pair |
|---|--------|------|
| 1 | XPR/XMD | XPR ↔ XMD |
| 2 | XBTC/XMD | Bitcoin ↔ XMD |
| 3 | XETH/XMD | Ethereum ↔ XMD |
| 7 | XMT/XMD | Metal DAO ↔ XMD |
| 9 | LOAN/XMD | LOAN ↔ XMD |
| 10 | METAL/XMD | Metal ↔ XMD |
| 11 | XDC/XMD | XDC ↔ XMD |
| 12 | XDOGE/XMD | Dogecoin ↔ XMD |
| 13 | XHBAR/XMD | Hedera ↔ XMD |
| 14 | XLTC/XMD | Litecoin ↔ XMD |
| 15 | XXRP/XMD | XRP ↔ XMD |
| 16 | XSOL/XMD | Solana ↔ XMD |
| 17 | XXLM/XMD | Stellar ↔ XMD |
| 18 | XADA/XMD | Cardano ↔ XMD |

Only XMD pairs are monitored. Markets are loaded from the on-chain `dex` contract and refreshed every 10 minutes.

---

## Architecture

```
┌─────────────┐     ┌──────────────────┐     ┌──────────────┐
│  Telegram    │◄────│  Metal X Order   │────►│  Hyperion    │
│  Users       │     │  Bot             │     │  API Pool    │
└─────────────┘     └──────────────────┘     └──────────────┘
                           │                        │
                    ┌──────┴──────┐          ┌──────┴──────┐
                    │  SQLite or  │          │  DEX Trades  │
                    │  PostgreSQL │          │  API (daily) │
                    └─────────────┘          └─────────────┘
```

### How It Works

The bot monitors **authoritative Metal X trade records** from the Metal X trades API. It does not infer fills from `dex → account` transfers, because those transfers can be referral-cut withdrawals or balance sweeps unrelated to a user's active order.

### Polling Loop

Every 3 seconds (configurable), for each verified user:
1. Queries the Metal X trades API for new executed trades across XMD markets
2. Formats the actual trade row into a notification
3. Sends Telegram notification (with dedup and rate limiting)
4. Advances the per-user trade checkpoint timestamp

### Daily Summary

Once per day at the configured hour, the bot fetches each user's trade history from the Metal X DEX API (`dex.api.mainnet.metalx.com`) and sends a summary with trade counts, buy/sell breakdown, and fees per token.

### Security Model

This is a read-only notification bot:

- It never asks for private keys.
- It has no signing dependency and does not construct transactions.
- It only reads Metal X trade data, Hyperion/RPC verification data, and sends Telegram notifications.
- It explicitly ignores `dex → account` transfers for fills because those can be referral cuts.
- Startup refuses private-key-shaped environment variables or common signing key names.
- `npm test` runs a source guard that blocks private-key/signing patterns in tracked files.
- Any live-chain testing that needs a transaction must happen outside the bot with the Proton CLI keychain, never with a key pasted into code or `.env`.

Read-only chain smoke test:

```bash
npm run smoke:proton
```

That script uses `proton table` only. It does not sign or mutate chain state.

### Endpoint Rotation

The bot maintains a health score for each Hyperion endpoint:
- On success: failure count decreases
- On failure: failure count increases, endpoint enters exponential backoff
- The bot always picks the healthiest available endpoint
- If all endpoints are in backoff, it tries the least-failed one

### Notification Dedup

Every notification is recorded in the database by `(chat_id, global_sequence)`. If the bot restarts and re-processes the same events, duplicates are silently skipped.

### Stale Protection

If the bot was offline for more than `MAX_STALE_SECONDS` (default: 5 minutes), it resets its checkpoint to "now" instead of replaying old events. This prevents notification floods after downtime.

---

## Bot Commands

| Command | Description |
|---------|-------------|
| `/start` | Welcome message and setup instructions |
| `/link <account>` | Link an XPR account with on-chain verification |
| `/unlink <account>` | Remove a linked account |
| `/status` | Show your linked accounts and verification status |
| `/markets` | List all Metal X XMD trading pairs |
| `/help` | Show all available commands |

---

## Troubleshooting

### Bot isn't responding
- Check that `TELEGRAM_BOT_TOKEN` is correct
- Make sure no other instance is running with the same token (Telegram only allows one long-polling connection per bot)

### Not receiving notifications
- Run `/status` to confirm your account is verified (✅ not ⏳)
- Check that you have active orders on Metal X
- Check the bot logs for Hyperion errors

### Verification not working
- Send any amount of XPR (we suggest `0.0001 XPR`) to `token.burn`
- The memo must be exactly `METALX-BOT` (case-sensitive)
- Make sure you're sending **from** the account you're trying to link
- The bot checks your recent transfer history — make sure the burn happened recently

### "All RPC endpoints failed"
- The default Hyperion endpoints may be temporarily down
- Add more endpoints via `HYPERION_ENDPOINTS` in your `.env`

### SQLite errors on Railway
- Railway's filesystem is ephemeral. Use PostgreSQL instead (add the plugin in Railway dashboard)

---

## Development

```bash
# Install dependencies
npm install

# Run with auto-reload
npm run dev

# Build
npm run build

# Run guard + build
npm test

# Read-only Proton CLI chain smoke test
npm run smoke:proton

# Type check
npx tsc --noEmit
```

### Project Structure

```
src/
├── index.ts            # Entry point, polling loop, verification
├── bot.ts              # Telegram bot commands (grammy)
├── hyperion.ts         # Hyperion client with endpoint rotation
├── markets.ts          # Market registry + price/amount formatting
├── notifications.ts    # Notification formatting, dedup, rate limiting
├── daily-summary.ts    # Daily trading summary via DEX trades API
├── types.ts            # Shared TypeScript interfaces
└── db/
    ├── index.ts        # Auto-detect SQLite vs PostgreSQL
    ├── sqlite.ts       # SQLite implementation (better-sqlite3)
    └── postgres.ts     # PostgreSQL implementation (pg)
```

---

## Contributing

Contributions welcome! This is an open-source community project.

1. Fork the repo
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Commit your changes (`git commit -am 'Add my feature'`)
4. Push to the branch (`git push origin feature/my-feature`)
5. Open a Pull Request

Please test locally before submitting.

---

## License

MIT — see [LICENSE](LICENSE).

---

## Created By

- [@charliebot87](https://x.com/charliebot87) — AI agent on XPR Network
- [@protonnz](https://x.com/protonnz) — XPR Network community

## Links

- [Metal X DEX](https://metalx.com)
- [XPR Network](https://xprnetwork.org)
- [WebAuth Wallet](https://webauth.com)
- [XPR Network Explorer](https://explorer.xprnetwork.org)
- [Metal X API Docs](https://api.dex.docs.metalx.com)

# Clean-slate note

This v2 repository was created from the read-only codebase without importing the original git history.
