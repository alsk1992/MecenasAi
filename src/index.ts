/**
 * Mecenas — Polski Asystent Prawny AI
 * Bielik LLM + RAG po polskich kodeksach
 *
 * Entry point - starts the gateway and all services
 */

import { config as dotenvConfig } from 'dotenv';
import { randomBytes } from 'crypto';
import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

// Load .env from ~/.mecenas/.env first, then CWD fallback
dotenvConfig({ path: join(homedir(), '.mecenas', '.env') });
dotenvConfig();

import { createGateway } from './gateway/index.js';
import { loadConfig } from './config/index.js';
import { logger } from './utils/logger.js';

// =============================================================================
// STARTUP PROGRESS INDICATOR
// =============================================================================

interface StartupStep {
  name: string;
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
  detail?: string;
}

const startupSteps: StartupStep[] = [];
let spinnerInterval: NodeJS.Timeout | null = null;
const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
let spinnerFrame = 0;

function addStep(name: string): number {
  return startupSteps.push({ name, status: 'pending' }) - 1;
}

function updateStep(idx: number, status: StartupStep['status'], detail?: string): void {
  if (startupSteps[idx]) {
    startupSteps[idx].status = status;
    if (detail) startupSteps[idx].detail = detail;
  }
  renderProgress();
}

function renderProgress(): void {
  if (!process.stdout.isTTY) return;
  const linesToClear = startupSteps.length + 2;
  process.stdout.write(`\x1b[${linesToClear}A\x1b[0J`);
  console.log('\n\x1b[1m⚖️  Uruchamianie Mecenasa...\x1b[0m\n');
  for (const step of startupSteps) {
    let icon: string;
    let color: string;
    switch (step.status) {
      case 'done': icon = '✓'; color = '\x1b[32m'; break;
      case 'failed': icon = '✗'; color = '\x1b[31m'; break;
      case 'running': icon = spinnerFrames[spinnerFrame % spinnerFrames.length]; color = '\x1b[36m'; break;
      default: icon = '○'; color = '\x1b[90m';
    }
    const detail = step.detail ? ` \x1b[90m(${step.detail})\x1b[0m` : '';
    console.log(`  ${color}${icon}\x1b[0m ${step.name}${detail}`);
  }
}

function startSpinner(): void {
  if (!process.stdout.isTTY) return;
  spinnerInterval = setInterval(() => {
    spinnerFrame = (spinnerFrame + 1) % spinnerFrames.length;
    renderProgress();
  }, 80);
}

function stopSpinner(): void {
  if (spinnerInterval) {
    clearInterval(spinnerInterval);
    spinnerInterval = null;
  }
}

// =============================================================================
// VALIDATION
// =============================================================================

function validateStartupRequirements(): void {
  const warnings: string[] = [];

  // Auto-generate credential encryption key if not set
  if (!process.env.MECENAS_CREDENTIAL_KEY) {
    const generated = randomBytes(32).toString('hex');
    process.env.MECENAS_CREDENTIAL_KEY = generated;
    const mecenasDir = join(homedir(), '.mecenas');
    const envPath = join(mecenasDir, '.env');
    try {
      if (!existsSync(mecenasDir)) mkdirSync(mecenasDir, { recursive: true });
      if (existsSync(envPath)) {
        const existing = readFileSync(envPath, 'utf-8');
        if (!existing.includes('MECENAS_CREDENTIAL_KEY=')) {
          appendFileSync(envPath, `\nMECENAS_CREDENTIAL_KEY=${generated}\n`);
        }
      } else {
        writeFileSync(envPath, `MECENAS_CREDENTIAL_KEY=${generated}\n`, { mode: 0o600 });
      }
    } catch {
      logger.warn('Nie udało się zapisać MECENAS_CREDENTIAL_KEY');
    }
  }

  // Mecenas works with Ollama (Bielik) by default — no API key required
  // Anthropic key is optional cloud fallback
  if (!process.env.OLLAMA_URL && !process.env.ANTHROPIC_API_KEY) {
    const msg = 'Brak OLLAMA_URL i ANTHROPIC_API_KEY. Mecenas wymaga co najmniej jednego dostawcy LLM.\n' +
      '  Ollama: OLLAMA_URL=http://localhost:11434\n' +
      '  Bielik: ollama pull SpeakLeash/bielik-11b-v2.2-instruct:Q4_K_M\n' +
      '  Anthropic: ANTHROPIC_API_KEY=sk-ant-...';
    logger.error(msg);
    throw new Error(msg);
  }

  if (!process.env.TELEGRAM_BOT_TOKEN) {
    warnings.push('Brak TELEGRAM_BOT_TOKEN. WebChat pod http://localhost:18789/webchat nadal działa.');
  }

  for (const warning of warnings) {
    logger.warn(warning);
  }
}

// =============================================================================
// MAIN
// =============================================================================

async function main() {
  process.on('unhandledRejection', (reason) => {
    logger.error({ reason }, 'Nieobsłużone odrzucenie Promise');
  });
  process.on('uncaughtException', (error) => {
    logger.error({ error }, 'Nieobsłużony wyjątek');
    process.exit(1);
  });

  const isTTY = process.stdout.isTTY;
  if (isTTY) {
    const idxValidate = addStep('Walidacja konfiguracji');
    const idxConfig = addStep('Ładowanie konfiguracji');
    const idxDatabase = addStep('Łączenie z bazą danych');
    const idxChannels = addStep('Łączenie kanałów');
    const idxGateway = addStep('Uruchamianie serwera HTTP');

    console.log('\n\x1b[1m⚖️  Uruchamianie Mecenasa...\x1b[0m\n');
    for (const step of startupSteps) {
      console.log(`  \x1b[90m○\x1b[0m ${step.name}`);
    }

    startSpinner();

    updateStep(idxValidate, 'running');
    try {
      validateStartupRequirements();
      updateStep(idxValidate, 'done');
    } catch (e) {
      updateStep(idxValidate, 'failed');
      stopSpinner();
      throw e;
    }

    updateStep(idxConfig, 'running');
    let config;
    try {
      config = loadConfig();
      updateStep(idxConfig, 'done', `port ${config.gateway.port}`);
    } catch (e) {
      updateStep(idxConfig, 'failed');
      stopSpinner();
      throw e;
    }

    updateStep(idxDatabase, 'running');
    updateStep(idxChannels, 'running');
    updateStep(idxGateway, 'running');

    let gateway;
    try {
      gateway = await createGateway(config);
      updateStep(idxDatabase, 'done');
      updateStep(idxChannels, 'done');
    } catch (e) {
      updateStep(idxDatabase, 'failed');
      stopSpinner();
      throw e;
    }

    try {
      await gateway.start();
      updateStep(idxGateway, 'done', `http://localhost:${config.gateway.port}`);
    } catch (e) {
      updateStep(idxGateway, 'failed');
      stopSpinner();
      throw e;
    }

    stopSpinner();
    renderProgress();

    console.log('\n\x1b[32m\x1b[1m✓ Mecenas działa!\x1b[0m');
    console.log(`\n  WebChat:  \x1b[36mhttp://localhost:${config.gateway.port}/webchat\x1b[0m`);
    if (process.env.TELEGRAM_BOT_TOKEN) {
      console.log('  Telegram: \x1b[32mPołączony\x1b[0m');
    }
    console.log(`\n  Model:    \x1b[33m${config.agent.model}\x1b[0m (${config.agent.provider})`);
    if (config.agent.speedModel) {
      console.log(`  Szybki:   \x1b[33m${config.agent.speedModel}\x1b[0m (proste pytania)`);
    }
    console.log('\n  Naciśnij Ctrl+C aby zatrzymać\n');

    let shuttingDown = false;
    const shutdown = async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      stopSpinner();
      console.log('\n\x1b[33mZatrzymywanie...\x1b[0m');
      try {
        await Promise.race([
          gateway.stop(),
          new Promise<void>((resolve) => setTimeout(() => {
            logger.warn('Przekroczono czas zamykania (15s)');
            resolve();
          }, 15000)),
        ]);
      } catch (e) {
        logger.error({ err: e }, 'Błąd podczas zamykania');
      }
      console.log('\x1b[32mDo widzenia!\x1b[0m\n');
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

  } else {
    logger.info('Uruchamianie Mecenasa...');
    validateStartupRequirements();
    const config = loadConfig();
    const gateway = await createGateway(config);
    await gateway.start();
    logger.info('Mecenas działa!');

    let shuttingDown = false;
    const shutdown = async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      logger.info('Zatrzymywanie...');
      try {
        await Promise.race([
          gateway.stop(),
          new Promise<void>((resolve) => setTimeout(() => resolve(), 15000)),
        ]);
      } catch (e) {
        logger.error({ err: e }, 'Błąd podczas zamykania');
      }
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  }
}

main().catch((err) => {
  stopSpinner();
  logger.error({ err }, 'Błąd krytyczny');
  process.exit(1);
});
