import { type ApiClient, ApiError } from '@app/api-client';
import type { Logger } from '@app/observability';
import { Bot } from 'grammy';
import type { BotContext } from './context.js';

/** Everything the bot needs, injected so the factory stays unit-testable. */
export interface CreateBotDeps {
  token: string;
  api: ApiClient;
  logger: Logger;
}

/** Welcome text shown by the /start command. */
export const WELCOME_MESSAGE = [
  'Welcome! I am the service bot for this workspace.',
  '',
  'I talk to the backend over a secure service token and can report live stats.',
  'Send /help to see everything I can do.',
].join('\n');

/** Renders the reply for a successful /stats lookup. Pure, so it is trivial to test. */
export function formatStats(count: number): string {
  return `Registered users: ${count}`;
}

/** Friendly fallback shown when the backend cannot be reached for /stats. */
export function formatStatsError(): string {
  return 'Sorry, I could not fetch the stats right now. Please try again in a moment.';
}

/** Renders the /help command listing. Pure, so it is trivial to test. */
export function formatHelp(): string {
  return [
    'Available commands:',
    '/start - Show the welcome message',
    '/stats - Show how many users are registered',
    '/help - Show this list of commands',
  ].join('\n');
}

/**
 * Core /stats logic separated from the grammY context so it can be unit-tested
 * with a mocked ApiClient. Returns the exact text to reply with; never throws.
 */
export async function buildStatsReply(api: ApiClient, logger: Logger): Promise<string> {
  try {
    const { count } = await api.usersCount();
    return formatStats(count);
  } catch (error) {
    if (error instanceof ApiError) {
      logger.error(
        { status: error.status, message: error.message },
        'Backend rejected the user-count request',
      );
    } else {
      logger.error({ err: error }, 'Unexpected failure while fetching the user count');
    }
    return formatStatsError();
  }
}

/**
 * Builds a fully configured (but not yet started) bot. Registers command
 * handlers and a global error handler. Deliberately does NOT register the
 * session middleware so this factory can be exercised without Redis.
 */
export function createBot(deps: CreateBotDeps): Bot<BotContext> {
  const { token, api, logger } = deps;
  const bot = new Bot<BotContext>(token);

  bot.command('start', (ctx) => ctx.reply(WELCOME_MESSAGE));

  bot.command('stats', async (ctx) => {
    await ctx.reply(await buildStatsReply(api, logger));
  });

  bot.command('help', (ctx) => ctx.reply(formatHelp()));

  bot.catch((err) => {
    logger.error(
      { err: err.error, updateId: err.ctx.update.update_id },
      'Unhandled error while processing a Telegram update',
    );
  });

  return bot;
}
