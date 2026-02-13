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
  const { createAgent, startDeadlineReminders } = await import('../agents/index.js');
  const agent = createAgent(config, db);

  // Message sending
  let telegramBot: any = null;
  let webchatSend: ((chatId: string, text: string) => void) | null = null;
  let webchatBroadcast: ((text: string) => void) | null = null;
  let stopReminders: (() => void) | null = null;

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

  // Handle incoming messages with timeout
  const MESSAGE_TIMEOUT_MS = 60_000; // 60 seconds max per message
  const pendingRequests = new Map<string, AbortController>();

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

    // Set up abort controller for cancel support
    const abortController = new AbortController();
    pendingRequests.set(message.chatId, abortController);

    try {
      const responsePromise = agent.handleMessage(message.text, session);
      const timeoutPromise = new Promise<null>((_, reject) => {
        const timer = setTimeout(() => reject(new Error('TIMEOUT')), MESSAGE_TIMEOUT_MS);
        abortController.signal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new Error('CANCELLED'));
        });
      });

      const response = await Promise.race([responsePromise, timeoutPromise]);

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
      const errMsg = (err as Error).message;
      if (errMsg === 'TIMEOUT') {
        logger.warn({ chatId: message.chatId }, 'Agent response timed out');
        await sendMessage({
          platform: message.platform,
          chatId: message.chatId,
          text: 'Przepraszam, generowanie odpowiedzi trwalo zbyt dlugo. Sprobuj ponownie z prostszym pytaniem.',
        });
      } else if (errMsg === 'CANCELLED') {
        logger.info({ chatId: message.chatId }, 'Agent response cancelled by user');
        await sendMessage({
          platform: message.platform,
          chatId: message.chatId,
          text: 'Generowanie odpowiedzi anulowane.',
        });
      } else {
        logger.error({ err }, 'Error handling message');
        await sendMessage({
          platform: message.platform,
          chatId: message.chatId,
          text: 'Przepraszam, wystapil blad. Prosze sprobowac ponownie.',
        });
      }
    } finally {
      pendingRequests.delete(message.chatId);
    }

    saveSession(session);
  }

  /** Cancel a pending agent request for a chat */
  function cancelRequest(chatId: string): boolean {
    const controller = pendingRequests.get(chatId);
    if (controller) {
      controller.abort();
      return true;
    }
    return false;
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

          // Auth middleware
          function checkTgAuth(ctx: any): boolean {
            const userId = String(ctx.from?.id);
            if (allowedUsers?.length && !allowedUsers.includes(userId)) {
              ctx.reply('Brak dostepu. Skontaktuj sie z administratorem.');
              return false;
            }
            return true;
          }

          // /start command
          telegramBot.command('start', async (ctx: any) => {
            if (!checkTgAuth(ctx)) return;
            await ctx.reply(
              'Witaj w Mecenasie! Jestem Twoim asystentem prawnym AI.\n\n'
              + 'Dostepne komendy:\n'
              + '/sprawy - Lista spraw\n'
              + '/terminy - Nadchodzace terminy\n'
              + '/dokumenty - Lista dokumentow\n'
              + '/klienci - Lista klientow\n'
              + '/szukaj <fraza> - Szukaj w kodeksach\n'
              + '/nowa - Nowa rozmowa\n'
              + '/pomoc - Pelna lista komend\n\n'
              + 'Mozesz tez pisac normalnie — odpowiem na kazde pytanie prawne.'
            );
          });

          // /pomoc command
          telegramBot.command('pomoc', async (ctx: any) => {
            if (!checkTgAuth(ctx)) return;
            await ctx.reply(
              'Komendy Mecenasa:\n\n'
              + 'Sprawy i klienci:\n'
              + '  /sprawy - Lista aktywnych spraw\n'
              + '  /klienci - Lista klientow\n\n'
              + 'Terminy i dokumenty:\n'
              + '  /terminy - Nadchodzace terminy\n'
              + '  /dokumenty - Szkice do sprawdzenia\n\n'
              + 'Faktury:\n'
              + '  /faktury - Lista faktur\n\n'
              + 'Wyszukiwanie:\n'
              + '  /szukaj <fraza> - Szukaj w kodeksach\n'
              + '  /art <nr> <kodeks> - Wyszukaj artykul (np. /art 415 KC)\n\n'
              + 'Inne:\n'
              + '  /nowa - Nowa rozmowa (czysta sesja)\n'
              + '  /pomoc - Ta wiadomosc'
            );
          });

          // /sprawy — list cases
          telegramBot.command('sprawy', async (ctx: any) => {
            if (!checkTgAuth(ctx)) return;
            const cases = db.listCases();
            if (cases.length === 0) {
              await ctx.reply('Brak spraw w bazie. Napisz "Utworz nowa sprawe" aby dodac.');
              return;
            }
            const lines = cases.slice(0, 15).map(c => {
              const syg = c.sygnatura ? ` (${c.sygnatura})` : '';
              return `- ${c.title}${syg} [${c.status}]`;
            });
            await ctx.reply(`Sprawy (${cases.length}):\n\n${lines.join('\n')}`);
          });

          // /terminy — list upcoming deadlines
          telegramBot.command('terminy', async (ctx: any) => {
            if (!checkTgAuth(ctx)) return;
            const deadlines = db.listDeadlines({ upcoming: true });
            if (deadlines.length === 0) {
              await ctx.reply('Brak nadchodzacych terminow.');
              return;
            }
            const lines = deadlines.slice(0, 15).map(d => {
              const legalCase = db.getCase(d.caseId);
              const dateStr = d.date.toLocaleDateString('pl-PL');
              return `- ${dateStr}: ${d.title} (${legalCase?.title ?? '?'}) [${d.type}]`;
            });
            await ctx.reply(`Nadchodzace terminy (${deadlines.length}):\n\n${lines.join('\n')}`);
          });

          // /dokumenty — list recent documents
          telegramBot.command('dokumenty', async (ctx: any) => {
            if (!checkTgAuth(ctx)) return;
            const docs = db.listDocuments();
            if (docs.length === 0) {
              await ctx.reply('Brak dokumentow. Napisz np. "Napisz pozew o zaplte" aby utworzyc.');
              return;
            }
            const lines = docs.slice(0, 15).map(d => {
              const statusIcon = d.status === 'szkic' ? '\u270f\ufe0f' : d.status === 'zatwierdzony' ? '\u2705' : '\ud83d\udcdd';
              return `${statusIcon} ${d.title} [${d.type}] - ${d.status}`;
            });
            await ctx.reply(`Dokumenty (${docs.length}):\n\n${lines.join('\n')}`);
          });

          // /klienci — list clients
          telegramBot.command('klienci', async (ctx: any) => {
            if (!checkTgAuth(ctx)) return;
            const clients = db.listClients();
            if (clients.length === 0) {
              await ctx.reply('Brak klientow. Napisz "Dodaj klienta Jan Kowalski" aby utworzyc.');
              return;
            }
            const lines = clients.slice(0, 15).map(c => {
              return `- ${c.name} (${c.type === 'osoba_fizyczna' ? 'os. fizyczna' : 'os. prawna'})`;
            });
            await ctx.reply(`Klienci (${clients.length}):\n\n${lines.join('\n')}`);
          });

          // /nowa — start a new conversation (fresh session)
          telegramBot.command('nowa', async (ctx: any) => {
            if (!checkTgAuth(ctx)) return;
            const userId = String(ctx.from.id);
            const chatId = String(ctx.chat.id);
            const key = `telegram:${chatId}`;
            // Remove old session from memory
            sessions.delete(key);
            // Create fresh session in DB
            const newSession: Session = {
              key: `telegram:${chatId}:${Date.now()}`,
              userId,
              channel: 'telegram',
              chatId,
              messages: [],
              createdAt: new Date(),
              updatedAt: new Date(),
            };
            db.upsertSession(newSession);
            sessions.set(`telegram:${chatId}`, newSession);
            await ctx.reply('Nowa rozmowa rozpoczeta. Jak moge pomoc?');
          });

          // /szukaj — search legal articles
          telegramBot.command('szukaj', async (ctx: any) => {
            if (!checkTgAuth(ctx)) return;
            const query = ctx.match?.trim();
            if (!query) {
              await ctx.reply('Uzycie: /szukaj <fraza>\nPrzyklad: /szukaj odszkodowanie');
              return;
            }
            const articles = db.searchArticles(query, undefined, 5);
            if (articles.length === 0) {
              await ctx.reply(`Nie znaleziono przepisow dla: "${query}"`);
              return;
            }
            const lines = articles.map(a => {
              const loc = [a.chapter, a.section].filter(Boolean).join(' > ');
              const contentPreview = a.content.slice(0, 150) + (a.content.length > 150 ? '...' : '');
              return `Art. ${a.articleNumber} ${a.codeName}${loc ? ` (${loc})` : ''}\n${contentPreview}`;
            });
            await ctx.reply(`Wyniki dla "${query}":\n\n${lines.join('\n\n')}`);
          });

          // /art — lookup specific article
          telegramBot.command('art', async (ctx: any) => {
            if (!checkTgAuth(ctx)) return;
            const args = ctx.match?.trim().split(/\s+/);
            if (!args || args.length < 2) {
              await ctx.reply('Uzycie: /art <numer> <kodeks>\nPrzyklad: /art 415 KC');
              return;
            }
            const articleNumber = args[0];
            const codeName = args[1].toUpperCase();
            const article = db.getArticle(codeName, articleNumber);
            if (!article) {
              await ctx.reply(`Nie znaleziono art. ${articleNumber} ${codeName}.`);
              return;
            }
            const loc = [article.chapter, article.section].filter(Boolean).join(' > ');
            await ctx.reply(`Art. ${article.articleNumber} ${article.codeName}${loc ? ` (${loc})` : ''}\n\n${article.content}`);
          });

          // /faktury — list invoices
          telegramBot.command('faktury', async (ctx: any) => {
            if (!checkTgAuth(ctx)) return;
            const invoices = db.listInvoices();
            if (invoices.length === 0) {
              await ctx.reply('Brak faktur. Napisz "Utworz fakture" w czacie aby dodac.');
              return;
            }
            const statusLabels: Record<string, string> = { szkic: 'Szkic', wystawiona: 'Wystawiona', oplacona: 'Oplacona', zalegla: 'Zalegla' };
            const lines = invoices.slice(0, 15).map((inv: any) => {
              const status = statusLabels[inv.status] ?? inv.status;
              return `${inv.number}: ${inv.amount} ${inv.currency} [${status}]`;
            });
            await ctx.reply(`Faktury (${invoices.length}):\n\n${lines.join('\n')}`);
          });

          // Generic text messages — forward to agent
          telegramBot.on('message:text', async (ctx: any) => {
            if (!checkTgAuth(ctx)) return;
            const userId = String(ctx.from.id);
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
          if (!allowedUsers?.length) {
            logger.warn('Telegram bot started WITHOUT allowedUsers — ALL Telegram users have access! Set TELEGRAM_ALLOWED_USERS to restrict.');
          }
          logger.info('Telegram bot started');
        } catch (err) {
          logger.warn({ err }, 'Failed to start Telegram bot');
        }
      }

      // Start HTTP server with WebSocket for WebChat
      await httpServer.start(config.gateway.port, config.gateway.bind, {
        onWebChatMessage: handleMessage,
        onCancel: cancelRequest,
        onSessionExpired: (key) => { sessions.delete(key); },
        setWebChatSend: (fn) => { webchatSend = fn; },
        setWebChatBroadcast: (fn) => { webchatBroadcast = fn; },
      });

      // Start deadline reminder system
      stopReminders = startDeadlineReminders(db, (reminders) => {
        for (const r of reminders) {
          const daysText = r.daysLeft === 1 ? '1 dzien' : `${Math.abs(r.daysLeft)} dni`;
          const dateStr = r.date.toLocaleDateString('pl-PL');
          let text: string;
          if (r.overdue) {
            text = `\u26a0\ufe0f TERMIN PRZETERMINOWANY: ${r.deadlineTitle}\nSprawa: ${r.caseTitle}\nData: ${dateStr} (${daysText} temu)`;
          } else {
            text = `\ud83d\udcc5 PRZYPOMNIENIE O TERMINIE: ${r.deadlineTitle}\nSprawa: ${r.caseTitle}\nData: ${dateStr}\nPozostalo: ${daysText}`;
          }
          // Broadcast to WebChat
          if (webchatBroadcast) webchatBroadcast(text);
          // Send via Telegram to all known sessions
          if (telegramBot) {
            const telegramSessions = db.raw().exec("SELECT DISTINCT chat_id FROM sessions WHERE channel = 'telegram'");
            if (telegramSessions.length && telegramSessions[0].values.length) {
              for (const row of telegramSessions[0].values) {
                const chatId = row[0] as string;
                telegramBot.api.sendMessage(chatId, text).catch((err: unknown) => {
                  logger.warn({ err, chatId }, 'Nie udało się wysłać przypomnienia Telegram');
                });
              }
            }
          }
          logger.info({ deadline: r.deadlineTitle, overdue: r.overdue }, 'Deadline reminder sent');
        }
      });

      if (config.gateway.auth === 'off') {
        logger.warn('API authentication is OFF — all endpoints are open! Set MECENAS_AUTH=token and MECENAS_TOKEN to secure.');
      }
      logger.info({ port: config.gateway.port }, 'Mecenas gateway started');
    },

    async stop() {
      if (!started) return;
      started = false;

      if (stopReminders) { stopReminders(); stopReminders = null; }

      if (telegramBot) {
        try { telegramBot.stop(); } catch {}
      }

      await httpServer.stop();
      db.close();
      logger.info('Mecenas gateway stopped');
    },
  };
}
