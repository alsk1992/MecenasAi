/**
 * Mecenas Gateway — simplified gateway for legal assistant
 * DB + sessions + channels + agent + HTTP server
 */

import { logger } from '../utils/logger.js';
import type { Config, IncomingMessage, OutgoingMessage, Session } from '../types.js';
import { createServer } from './server.js';
import { initDatabase, type Database } from '../db/index.js';

export interface AppGateway {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export async function createGateway(config: Config): Promise<AppGateway> {
  // Railway/Heroku inject PORT
  const envPort = parseInt(process.env.PORT ?? '', 10);
  if (envPort > 0 && envPort <= 65535) {
    config = { ...config, gateway: { ...config.gateway, port: envPort } };
  }

  // Initialize database
  const db = await initDatabase();

  // Simple session management
  const sessions = new Map<string, Session>();

  function getOrCreateSession(message: IncomingMessage): Session {
    const key = `${message.platform}:${message.chatId}`;
    let session = sessions.get(key);
    if (!session) {
      // Check DB
      const dbSession = db.getLatestSessionForChat(message.platform, message.chatId);
      if (dbSession) {
        session = dbSession;
        sessions.set(key, session);
      } else {
        session = {
          key,
          userId: message.userId,
          channel: message.platform,
          chatId: message.chatId,
          messages: [],
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        db.upsertUser(message.userId);
        db.upsertSession(session);
        sessions.set(key, session);
      }
    }
    return session;
  }

  function saveSession(session: Session): void {
    session.updatedAt = new Date();
    sessions.set(session.key, session);
    db.upsertSession(session);
  }

  // Create agent (lazy import to avoid circular deps)
  const { createAgent } = await import('../agents/index.js');
  const agent = createAgent(config, db);

  // Message sending
  let telegramBot: any = null;
  let webchatSend: ((chatId: string, text: string) => void) | null = null;

  const sendMessage = async (msg: OutgoingMessage): Promise<void> => {
    if (msg.platform === 'telegram' && telegramBot) {
      try {
        await telegramBot.api.sendMessage(msg.chatId, msg.text, {
          parse_mode: msg.parseMode ?? 'Markdown',
        });
      } catch (err) {
        logger.warn({ err, chatId: msg.chatId }, 'Failed to send Telegram message');
      }
    } else if (msg.platform === 'webchat' && webchatSend) {
      webchatSend(msg.chatId, msg.text);
    }
  };

  // Handle incoming messages
  async function handleMessage(message: IncomingMessage): Promise<void> {
    const session = getOrCreateSession(message);

    // Add user message to history
    session.messages.push({
      role: 'user',
      content: message.text,
      timestamp: new Date(),
    });

    // Trim history
    const maxMessages = config.session?.maxMessages ?? 50;
    if (session.messages.length > maxMessages) {
      session.messages = session.messages.slice(-maxMessages);
    }

    try {
      const response = await agent.handleMessage(message.text, session);

      if (response) {
        session.messages.push({
          role: 'assistant',
          content: response,
          timestamp: new Date(),
        });

        await sendMessage({
          platform: message.platform,
          chatId: message.chatId,
          text: response,
          parseMode: 'Markdown',
        });
      }
    } catch (err) {
      logger.error({ err }, 'Error handling message');
      await sendMessage({
        platform: message.platform,
        chatId: message.chatId,
        text: 'Przepraszam, wystąpił błąd. Proszę spróbować ponownie.',
      });
    }

    saveSession(session);
  }

  // Create HTTP server
  const httpServer = createServer(config, db);

  let started = false;

  return {
    async start() {
      if (started) return;
      started = true;

      // Start Telegram if configured
      if (config.channels.telegram?.token) {
        try {
          const { Bot } = await import('grammy');
          telegramBot = new Bot(config.channels.telegram.token);
          const allowedUsers = config.channels.telegram.allowedUsers;

          telegramBot.on('message:text', async (ctx: any) => {
            const userId = String(ctx.from.id);
            if (allowedUsers?.length && !allowedUsers.includes(userId)) {
              await ctx.reply('Brak dostępu. Skontaktuj się z administratorem.');
              return;
            }
            await handleMessage({
              id: String(ctx.message.message_id),
              platform: 'telegram',
              userId,
              chatId: String(ctx.chat.id),
              chatType: ctx.chat.type === 'private' ? 'dm' : 'group',
              text: ctx.message.text,
              timestamp: new Date(ctx.message.date * 1000),
            });
          });

          telegramBot.start();
          logger.info('Telegram bot started');
        } catch (err) {
          logger.warn({ err }, 'Failed to start Telegram bot');
        }
      }

      // Start HTTP server with WebSocket for WebChat
      await httpServer.start(config.gateway.port, config.gateway.bind, {
        onWebChatMessage: handleMessage,
        setWebChatSend: (fn) => { webchatSend = fn; },
      });

      logger.info({ port: config.gateway.port }, 'Mecenas gateway started');
    },

    async stop() {
      if (!started) return;
      started = false;

      if (telegramBot) {
        try { telegramBot.stop(); } catch {}
      }

      await httpServer.stop();
      db.close();
      logger.info('Mecenas gateway stopped');
    },
  };
}
