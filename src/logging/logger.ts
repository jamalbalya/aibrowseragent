import { redactValue, redact } from '@/security/redaction/secret-redactor';

/** Log categories (specification section 29). */
export const LOG_CATEGORIES = [
  'agent',
  'tool',
  'policy',
  'permission',
  'provider',
  'task',
  'browser',
  'debugger',
  'connector',
  'security',
  'storage',
  'messaging',
  'ui',
] as const;

export type LogCategory = (typeof LOG_CATEGORIES)[number];

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LogRecord {
  readonly timestamp: number;
  readonly level: LogLevel;
  readonly category: LogCategory;
  readonly message: string;
  readonly context?: Record<string, unknown>;
}

export interface LogSink {
  write(record: LogRecord): void;
}

/**
 * Writes to the platform console.
 *
 * This is the one place in the codebase permitted to call `console` (see the
 * `no-console` lint rule); everything else logs through this module so that
 * redaction is not bypassable.
 */
export class ConsoleSink implements LogSink {
  write(record: LogRecord): void {
    const prefix = `[${record.category}]`;
    const args: unknown[] = [prefix, record.message];
    if (record.context) args.push(record.context);
    /* eslint-disable no-console */
    switch (record.level) {
      case 'debug':
        console.debug(...args);
        break;
      case 'info':
        console.info(...args);
        break;
      case 'warn':
        console.warn(...args);
        break;
      case 'error':
        console.error(...args);
        break;
    }
    /* eslint-enable no-console */
  }
}

/** Keeps the most recent records in memory for the debug view and tests. */
export class MemorySink implements LogSink {
  private readonly records: LogRecord[] = [];

  constructor(private readonly capacity = 500) {}

  write(record: LogRecord): void {
    this.records.push(record);
    if (this.records.length > this.capacity) {
      this.records.splice(0, this.records.length - this.capacity);
    }
  }

  all(): readonly LogRecord[] {
    return [...this.records];
  }

  clear(): void {
    this.records.length = 0;
  }
}

export interface LoggerOptions {
  readonly level?: LogLevel;
  readonly sinks?: readonly LogSink[];
}

/**
 * Structured logger.
 *
 * Every message and context object is redacted before it reaches a sink, so a
 * caller cannot leak a credential into logs by mistake.
 */
export class Logger {
  private level: LogLevel;
  private readonly sinks: LogSink[];

  constructor(
    private readonly category: LogCategory,
    options: LoggerOptions = {},
  ) {
    this.level = options.level ?? 'info';
    this.sinks = [...(options.sinks ?? [new ConsoleSink()])];
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  addSink(sink: LogSink): void {
    this.sinks.push(sink);
  }

  private emit(level: LogLevel, message: string, context?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) return;

    const record: LogRecord = {
      timestamp: Date.now(),
      level,
      category: this.category,
      message: redact(message),
      ...(context === undefined
        ? {}
        : { context: redactValue(context) as Record<string, unknown> }),
    };

    for (const sink of this.sinks) {
      try {
        sink.write(record);
      } catch {
        // A failing sink must never break the caller's control flow.
      }
    }
  }

  debug(message: string, context?: Record<string, unknown>): void {
    this.emit('debug', message, context);
  }
  info(message: string, context?: Record<string, unknown>): void {
    this.emit('info', message, context);
  }
  warn(message: string, context?: Record<string, unknown>): void {
    this.emit('warn', message, context);
  }
  error(message: string, context?: Record<string, unknown>): void {
    this.emit('error', message, context);
  }
}

const sharedSinks: LogSink[] = [new ConsoleSink()];
const sharedMemorySink = new MemorySink();
sharedSinks.push(sharedMemorySink);

let sharedLevel: LogLevel = 'info';
const registry = new Map<LogCategory, Logger>();

/** Returns the process-wide logger for a category. */
export function getLogger(category: LogCategory): Logger {
  let logger = registry.get(category);
  if (!logger) {
    logger = new Logger(category, { level: sharedLevel, sinks: sharedSinks });
    registry.set(category, logger);
  }
  return logger;
}

/** Raises or lowers verbosity for every category at once (debug mode toggle). */
export function setGlobalLogLevel(level: LogLevel): void {
  sharedLevel = level;
  for (const logger of registry.values()) logger.setLevel(level);
}

export function recentLogs(): readonly LogRecord[] {
  return sharedMemorySink.all();
}
