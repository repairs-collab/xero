import { redact } from './redaction.js';

export interface LogEvent {
  event: string;
  outcome?: string;
  organisationId?: string;
  correlationId?: string;
  jobId?: string;
  webhookId?: string;
  details?: Record<string, unknown>;
  error?: unknown;
}

export interface StructuredLogger {
  info(event: LogEvent): void;
  warn(event: LogEvent): void;
  error(event: LogEvent): void;
}

export function createLogger(input: { service: string; environment: string; sink?: (line: string) => void; clock?: { now(): Date } }): StructuredLogger {
  const sink = input.sink ?? ((line: string) => process.stdout.write(`${line}\n`));
  const clock = input.clock ?? { now: () => new Date() };
  const emit = (level: 'info' | 'warn' | 'error', event: LogEvent) => sink(JSON.stringify(redact({ timestamp: clock.now(), level, service: input.service, environment: input.environment, organisationId: event.organisationId ?? null, correlationId: event.correlationId ?? null, jobId: event.jobId ?? null, webhookId: event.webhookId ?? null, event: event.event, outcome: event.outcome ?? null, details: event.details ?? null, error: event.error instanceof Error ? { name: event.error.name, message: event.error.message } : event.error ?? null })));
  return { info: (event) => emit('info', event), warn: (event) => emit('warn', event), error: (event) => emit('error', event) };
}
