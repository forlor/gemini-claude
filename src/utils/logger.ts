import { getConfig } from '../config.js';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_VALUES: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3
};

function getTimestamp(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const date = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');
  const ms = String(now.getMilliseconds()).padStart(3, '0');
  return `${year}-${month}-${date} ${hours}:${minutes}:${seconds}.${ms}`;
}

function shouldLog(level: LogLevel): boolean {
  const config = getConfig();
  if (!config.LOG) {
    return false;
  }
  const configLevel = config.LOG_LEVEL || 'info';
  const currentVal = LEVEL_VALUES[level];
  const targetVal = LEVEL_VALUES[configLevel];
  return currentVal >= targetVal;
}

function logMessage(level: LogLevel, message: string, requestId?: string) {
  if (!shouldLog(level)) {
    return;
  }
  
  const timestamp = getTimestamp();
  const reqStr = requestId ? ` [${requestId}]` : '';
  const levelStr = level.toUpperCase().padEnd(5);
  
  const formatted = `[${timestamp}] [${levelStr}]${reqStr} ${message}`;
  
  if (level === 'error') {
    console.error(formatted);
  } else if (level === 'warn') {
    console.warn(formatted);
  } else {
    console.log(formatted);
  }
}

export const logger = {
  debug(message: string, requestId?: string) {
    logMessage('debug', message, requestId);
  },
  info(message: string, requestId?: string) {
    logMessage('info', message, requestId);
  },
  warn(message: string, requestId?: string) {
    logMessage('warn', message, requestId);
  },
  error(message: string, requestId?: string) {
    logMessage('error', message, requestId);
  }
};
