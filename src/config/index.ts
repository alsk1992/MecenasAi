/**
 * Mecenas Configuration
 */

import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';
import { logger } from '../utils/logger.js';
import type { Config } from '../types.js';

const STATE_DIR = join(homedir(), '.mecenas');
const CONFIG_FILE = join(STATE_DIR, 'mecenas.json');

export function resolveStateDir(): string {
  const override = process.env.MECENAS_STATE_DIR?.trim();
  if (override) {
    if (override.startsWith('~')) {
      return resolve(override.replace(/^~(?=$|[\\/])/, homedir()));
    }
    return resolve(override);
  }
  return STATE_DIR;
}

export { CONFIG_FILE };

function safeParseInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function loadConfig(): Config {
  let fileConfig: Partial<Config> = {};

  if (existsSync(CONFIG_FILE)) {
    try {
      const raw = readFileSync(CONFIG_FILE, 'utf-8');
      fileConfig = JSON.parse(raw);
    } catch (err) {
      logger.warn({ err }, 'Nie udało się załadować pliku konfiguracyjnego');
    }
  }

  const defaultModel = process.env.MECENAS_MODEL
    ?? 'SpeakLeash/bielik-11b-v2.2-instruct:Q4_K_M';

  const hasOllama = !!process.env.OLLAMA_URL;
  const hasAnthropic = !!process.env.ANTHROPIC_API_KEY;
  const defaultProvider = hasOllama ? 'ollama' : (hasAnthropic ? 'anthropic' : 'ollama');

  // Parse and clamp values
  const port = safeParseInt(process.env.PORT ?? process.env.MECENAS_PORT, fileConfig.gateway?.port ?? 18789);
  const temperature = fileConfig.agent?.temperature ?? 0.3;
  const maxMessages = fileConfig.session?.maxMessages ?? 50;

  const speedModel = process.env.MECENAS_SPEED_MODEL
    ?? fileConfig.agent?.speedModel
    ?? 'gemma3:4b';

  // Privacy config
  const privacyModeRaw = process.env.MECENAS_PRIVACY_MODE ?? (fileConfig.privacy as any)?.mode ?? 'auto';
  const privacyMode = (['auto', 'strict', 'off'].includes(privacyModeRaw) ? privacyModeRaw : 'auto') as 'auto' | 'strict' | 'off';

  const config: Config = {
    privacy: {
      mode: privacyMode,
      blockCloudOnPii: (fileConfig.privacy as any)?.blockCloudOnPii ?? true,
      anonymizeForCloud: (fileConfig.privacy as any)?.anonymizeForCloud ?? true,
      stripActiveCaseForCloud: (fileConfig.privacy as any)?.stripActiveCaseForCloud ?? true,
    },
    agent: {
      model: fileConfig.agent?.model ?? defaultModel,
      speedModel,
      provider: (fileConfig.agent?.provider ?? defaultProvider) as 'ollama' | 'anthropic',
      maxTokens: Math.max(256, Math.min(fileConfig.agent?.maxTokens ?? 4096, 65536)),
      temperature: Math.max(0, Math.min(Number(temperature) || 0.3, 2)),
      ollamaUrl: process.env.OLLAMA_URL ?? fileConfig.agent?.ollamaUrl ?? 'http://localhost:11434',
      anthropicKey: process.env.ANTHROPIC_API_KEY ?? fileConfig.agent?.anthropicKey,
    },
    gateway: {
      port: Math.max(1, Math.min(port, 65535)),
      bind: (['loopback', 'all'].includes(process.env.MECENAS_BIND ?? '')
        ? process.env.MECENAS_BIND as 'loopback' | 'all'
        : fileConfig.gateway?.bind ?? 'loopback') as 'loopback' | 'all',
      cors: fileConfig.gateway?.cors,
      auth: fileConfig.gateway?.auth ?? 'off',
      token: process.env.MECENAS_TOKEN ?? fileConfig.gateway?.token,
      password: process.env.MECENAS_PASSWORD ?? fileConfig.gateway?.password,
    },
    channels: {
      telegram: process.env.TELEGRAM_BOT_TOKEN ? {
        token: process.env.TELEGRAM_BOT_TOKEN,
        allowedUsers: process.env.TELEGRAM_ALLOWED_USERS?.split(',').map(s => s.trim()),
      } : fileConfig.channels?.telegram,
      webchat: {
        enabled: true,
        token: process.env.WEBCHAT_TOKEN ?? fileConfig.channels?.webchat?.token,
      },
    },
    session: {
      maxMessages: Math.max(1, Math.min(Number(maxMessages) || 50, 1000)),
      ttlMs: fileConfig.session?.ttlMs ?? 24 * 60 * 60 * 1000,
    },
    http: {
      rateLimitPerMin: Math.max(1, Math.min(fileConfig.http?.rateLimitPerMin ?? 60, 10000)),
      retryCount: fileConfig.http?.retryCount ?? 3,
      retryDelayMs: fileConfig.http?.retryDelayMs ?? 1000,
    },
  };

  return config;
}
