/**
 * Logger utility using Pino
 */

// @ts-ignore - pino CJS/ESM interop
import pino from 'pino';

const level = process.env.LOG_LEVEL || 'info';

const rootLogger = (pino as any)({
  level,
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'SYS:standard',
      ignore: 'pid,hostname',
    },
  },
});

export function createLogger(name: string) {
  return rootLogger.child({ name });
}

export { rootLogger as logger };
