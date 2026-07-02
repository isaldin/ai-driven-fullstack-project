import type { Context, SessionFlavor } from 'grammy';

/**
 * Data persisted per chat by the session middleware (Redis-backed in production).
 * Kept intentionally small so it is cheap to serialize on every update.
 */
export interface SessionData {
  /** Number of commands this chat has issued so far. */
  commandCount: number;
}

/**
 * Produces a fresh session object for chats the storage has never seen.
 * Must return a NEW object each call so unrelated chats never share state.
 */
export function initialSession(): SessionData {
  return { commandCount: 0 };
}

/** grammY context augmented with typed, persistent session access. */
export type BotContext = Context & SessionFlavor<SessionData>;
