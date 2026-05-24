import { Bot, GrammyError, HttpError } from 'grammy';
import type { IDatabase } from './types.js';
import type { MarketRegistry } from './markets.js';
import type { NotificationService } from './notifications.js';
import type { HyperionClient } from './hyperion.js';

const VERIFICATION_AMOUNT = '0.0001 XPR';
const VERIFICATION_RECIPIENT = 'token.burn';
const VERIFICATION_MEMO = 'METALX-BOT';

function isValidAccount(account: string): boolean {
  // XPR Network account names: 1-12 chars, a-z1-5.
  return /^[a-z1-5.]{1,12}$/.test(account) && !account.startsWith('.');
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function setupBot(
  bot: Bot,
  db: IDatabase,
  markets: MarketRegistry,
  notifications: NotificationService,
  hyperion: HyperionClient,
): void {
  // ─── /start ───────────────────────────────────────────────────────────────

  bot.command('start', async ctx => {
    const chatId = String(ctx.chat.id);
    const welcome = [
      '👋 <b>Welcome to Metal X Order Bot!</b>',
      '',
      'Get real-time Telegram notifications whenever your orders fill on <a href="https://metalx.com">Metal X DEX</a> (XPR Network).',
      '',
      '<b>Getting started:</b>',
      '1. Link your XPR account: <code>/link youraccountname</code>',
      '2. Follow the verification steps to confirm ownership',
      '3. Start receiving fill notifications automatically',
      '',
      'Type /help to see all available commands.',
    ].join('\n');

    await ctx.reply(welcome, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
  });

  // ─── /help ───────────────────────────────────────────────────────────────

  bot.command('help', async ctx => {
    const text = [
      '<b>Metal X Order Bot — Commands</b>',
      '',
      '/link <code>&lt;account&gt;</code> — Link an XPR account to receive fill notifications',
      '/unlink <code>&lt;account&gt;</code> — Remove a linked account',
      '/status — Show your linked accounts and notification status',
      '/markets — List all Metal X XMD trading pairs',
      '/help — Show this message',
      '',
      '<b>How it works:</b>',
      '• The bot monitors the Metal X DEX smart contract on XPR Network',
      '• When your orders fill (fully or partially), you receive a Telegram notification',
      '• Link multiple accounts if needed',
      '',
      '<b>Links:</b>',
      '• <a href="https://metalx.com">Metal X DEX</a>',
      '• <a href="https://github.com/charliebot87/metalx-order-bot">Source Code</a>',
    ].join('\n');

    await ctx.reply(text, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
  });

  // ─── /link <account> ──────────────────────────────────────────────────────

  bot.command('link', async ctx => {
    const chatId = String(ctx.chat.id);
    const arg = ctx.message?.text?.split(/\s+/)[1]?.toLowerCase().trim();

    if (!arg) {
      return ctx.reply(
        '❌ Usage: /link <code>youraccountname</code>\n\nExample: <code>/link alice</code>',
        { parse_mode: 'HTML' },
      );
    }

    if (!isValidAccount(arg)) {
      return ctx.reply(
        '❌ Invalid XPR account name. Accounts must be 1–12 lowercase characters (a–z, 1–5, .).',
        { parse_mode: 'HTML' },
      );
    }

    // Check if already linked and verified
    const existing = await db.getUserByChatId(chatId);
    const alreadyVerified = existing.find(u => u.xpr_account === arg && u.verified);
    if (alreadyVerified) {
      return ctx.reply(
        `✅ <code>${escapeHtml(arg)}</code> is already linked to your Telegram account.`,
        { parse_mode: 'HTML' },
      );
    }

    // Check if another user already has this account verified
    const otherUser = await db.getUserByAccount(arg);
    if (otherUser && otherUser.telegram_chat_id !== chatId) {
      return ctx.reply(
        `❌ The account <code>${escapeHtml(arg)}</code> is already linked to another Telegram user.`,
        { parse_mode: 'HTML' },
      );
    }

    await db.upsertUser(chatId, arg, VERIFICATION_MEMO);

    const instructions = [
      `🔗 <b>Verification required for <code>${escapeHtml(arg)}</code></b>`,
      '',
      'To prove you own this account, send a small XPR transfer:',
      '',
      `• <b>From:</b> <code>${escapeHtml(arg)}</code>`,
      `• <b>To:</b> <code>${VERIFICATION_RECIPIENT}</code>`,
      `• <b>Amount:</b> <code>${VERIFICATION_AMOUNT}</code> (or any amount)`,
      `• <b>Memo:</b> <code>${VERIFICATION_MEMO}</code>`,
      '',
      '🔥 The XPR is sent to <code>token.burn</code> — a tiny burn to verify ownership.',
      '',
      '⏳ The bot will automatically detect the transfer and verify your account within a few seconds.',
      '',
      '<b>Using WebAuth Wallet:</b>',
      '1. Open <a href="https://webauth.com">WebAuth Wallet</a>',
      `2. Send <code>${VERIFICATION_AMOUNT}</code> XPR to <code>${VERIFICATION_RECIPIENT}</code>`,
      `3. Set the memo to: <code>${VERIFICATION_MEMO}</code>`,
    ].join('\n');

    await ctx.reply(instructions, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
  });

  // ─── /unlink <account> ────────────────────────────────────────────────────

  bot.command('unlink', async ctx => {
    const chatId = String(ctx.chat.id);
    const arg = ctx.message?.text?.split(/\s+/)[1]?.toLowerCase().trim();

    const userRows = await db.getUserByChatId(chatId);
    if (userRows.length === 0) {
      return ctx.reply("You don't have any linked accounts.");
    }

    if (!arg) {
      if (userRows.length === 1) {
        // Only one account — unlink it directly
        const account = userRows[0].xpr_account;
        await db.unlinkUser(chatId, account);
        return ctx.reply(`✅ <code>${escapeHtml(account)}</code> has been unlinked.`, { parse_mode: 'HTML' });
      }
      const list = userRows.map(u => `• <code>${escapeHtml(u.xpr_account)}</code>`).join('\n');
      return ctx.reply(
        `You have multiple linked accounts. Specify which to unlink:\n${list}\n\nUsage: /unlink <code>accountname</code>`,
        { parse_mode: 'HTML' },
      );
    }

    const target = userRows.find(u => u.xpr_account === arg);
    if (!target) {
      return ctx.reply(
        `❌ <code>${escapeHtml(arg)}</code> is not linked to your account.`,
        { parse_mode: 'HTML' },
      );
    }

    await db.unlinkUser(chatId, arg);
    await ctx.reply(`✅ <code>${escapeHtml(arg)}</code> has been unlinked.`, { parse_mode: 'HTML' });
  });

  // ─── /status ──────────────────────────────────────────────────────────────

  bot.command('status', async ctx => {
    const chatId = String(ctx.chat.id);
    const rows = await db.getUserByChatId(chatId);

    if (rows.length === 0) {
      return ctx.reply(
        'No accounts linked yet.\n\nUse /link <code>accountname</code> to get started.',
        { parse_mode: 'HTML' },
      );
    }

    const lines = ['<b>Your linked accounts:</b>', ''];
    for (const row of rows) {
      const icon = row.verified ? '✅' : '⏳';
      const statusText = row.verified ? 'verified' : 'pending verification';
      lines.push(`${icon} <code>${escapeHtml(row.xpr_account)}</code> — ${statusText}`);
    }

    lines.push('');
    lines.push('The bot monitors all XMD trading pairs on Metal X for your order fills.');

    await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
  });

  // ─── /markets ─────────────────────────────────────────────────────────────

  bot.command('markets', async ctx => {
    const all = await markets.getAll();
    const lines = ['<b>Metal X — Supported Markets (XMD pairs)</b>', ''];
    for (const m of all) {
      lines.push(`• ${m.bidSymbol}/<b>${m.askSymbol}</b> (market #${m.market_id})`);
    }
    lines.push('', `Total: ${all.length} markets`);
    lines.push('', '<a href="https://app.metalx.com">Trade on Metal X →</a>');

    await ctx.reply(lines.join('\n'), { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
  });

  // ─── Error handler ─────────────────────────────────────────────────────────

  bot.catch(err => {
    const ctx = err.ctx;
    console.error(`[bot] Error handling update ${ctx.update.update_id}:`);
    if (err.error instanceof GrammyError) {
      console.error('[bot] GrammyError:', err.error.description);
    } else if (err.error instanceof HttpError) {
      console.error('[bot] HttpError:', err.error);
    } else {
      console.error('[bot] Unknown error:', err.error);
    }
  });
}
