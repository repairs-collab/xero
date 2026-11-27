import { createTransport } from 'nodemailer';
import type { SMTPTransportOptions } from 'nodemailer/lib/smtp-transport';
import { renderLifecycleEmail, type LifecycleEmailContentInput, type RenderedLifecycleEmail } from './templates.js';

export interface LifecycleEmailClientConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  fromName: string;
  fromAddress: string;
  replyTo: string;
}

export type LifecycleEmailNotice = LifecycleEmailContentInput & { recipient: string };

interface Message extends RenderedLifecycleEmail {
  from: { name: string; address: string };
  replyTo: string;
  to: string;
}

export interface LifecycleEmailTransport {
  sendMail(message: Message): Promise<unknown>;
}

type TransportFactory = (options: SMTPTransportOptions) => LifecycleEmailTransport;

export type LifecycleEmailOutcome =
  | { status: 'SENT'; messageId: string; providerMessageId?: string }
  | { status: 'RETRY'; failureCode: 'SMTP_CONNECTION_FAILURE' | 'SMTP_AUTH_FAILURE' | 'SMTP_TEMPORARY_REJECTION' }
  | { status: 'FAILED'; failureCode: 'INVALID_RECIPIENT' | 'INVALID_TEMPLATE' | 'SMTP_PERMANENT_REJECTION' }
  | { status: 'UNKNOWN'; failureCode: 'SMTP_ACCEPTANCE_UNCONFIRMED' | 'SMTP_SUBMISSION_UNCERTAIN' };

function bareMailbox(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 320 && !/[\p{Cc}\s(),;:<>"[\]\\]/u.test(value)
    && /^[^@]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(value);
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
}

function rejection(responseCode: unknown): LifecycleEmailOutcome | undefined {
  if (typeof responseCode !== 'number' || !Number.isInteger(responseCode)) return;
  if (responseCode >= 400 && responseCode < 500) return { status: 'RETRY', failureCode: 'SMTP_TEMPORARY_REJECTION' };
  if (responseCode >= 500 && responseCode < 600) return { status: 'FAILED', failureCode: 'SMTP_PERMANENT_REJECTION' };
}

function classifyError(error: unknown): LifecycleEmailOutcome {
  const { code, originalCode, command, timeoutType, responseCode, syscall } = record(error);
  const uncertain = { status: 'UNKNOWN', failureCode: 'SMTP_SUBMISSION_UNCERTAIN' } as const;
  if (command === 'QUIT' || command === 'RSET') return uncertain;
  const authCommand = typeof command === 'string' && /^AUTH(?: |$)/.test(command);
  const setupCommands = ['EHLO', 'HELO', 'STARTTLS', 'MAIL FROM', 'RCPT TO'];
  const preDataCommand = typeof command === 'string' && setupCommands.includes(command);
  if (responseCode !== undefined) {
    if (!authCommand && !preDataCommand && command !== 'DATA') return uncertain;
    return rejection(responseCode) ?? uncertain;
  }
  if (command === 'DATA') return uncertain;
  if (authCommand || code === 'EAUTH') return { status: 'RETRY', failureCode: 'SMTP_AUTH_FAILURE' };

  // Nodemailer also labels mid-message socket failures "CONN". Only specific
  // setup errors, setup timers or known pre-DATA commands prove it is safe to retry.
  const setupCodes = ['EDNS', 'ETLS', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'];
  const setupTimers = ['CONNECT_TIMEOUT', 'GREETING_TIMEOUT', 'UPGRADE_TIMEOUT'];
  if (syscall === 'connect' || [code, originalCode].some((item) => typeof item === 'string' && setupCodes.includes(item))
    || (code === 'ETIMEDOUT' && typeof timeoutType === 'string' && setupTimers.includes(timeoutType))
    || preDataCommand) {
    return { status: 'RETRY', failureCode: 'SMTP_CONNECTION_FAILURE' };
  }
  return uncertain;
}

const localAtom = '[A-Za-z0-9_-]+';
const hostLabel = '[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?';
const generatedMessageId = new RegExp(`^<${localAtom}(?:[.]${localAtom})*@${hostLabel}(?:[.]${hostLabel})*>$`, 'u');

function validHeaderMessageId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 512 && generatedMessageId.test(value);
}

function safeProviderMessageId(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length <= 512 && !/\p{Cc}/u.test(value)) {
    return value.trim() || undefined;
  }
}

function classifyReply(reply: unknown, recipient: string): LifecycleEmailOutcome {
  const { accepted, rejected, rejectedErrors, messageId, serverMessageId } = record(reply);
  const uncertain = { status: 'UNKNOWN', failureCode: 'SMTP_ACCEPTANCE_UNCONFIRMED' } as const;
  if (!Array.isArray(accepted) || !Array.isArray(rejected)) return uncertain;
  const matches = (address: unknown) => typeof address === 'string' && address.toLowerCase() === recipient.toLowerCase();
  if (validHeaderMessageId(messageId) && accepted.length === 1 && matches(accepted[0]) && rejected.length === 0
    && (rejectedErrors === undefined || (Array.isArray(rejectedErrors) && rejectedErrors.length === 0))) {
    const providerMessageId = safeProviderMessageId(serverMessageId);
    return providerMessageId ? { status: 'SENT', messageId, providerMessageId }
      : { status: 'SENT', messageId };
  }
  if (accepted.length === 0 && rejected.length === 1 && matches(rejected[0]) && Array.isArray(rejectedErrors)) {
    const errors = rejectedErrors.map(record).filter((error) => matches(error.recipient));
    if (errors.length === 1 && errors[0]?.command === 'RCPT TO') return rejection(errors[0].responseCode) ?? uncertain;
  }
  return uncertain;
}

export function createLifecycleEmailClient(config: LifecycleEmailClientConfig, factory: TransportFactory = createTransport) {
  const { host, port, secure, user, pass, fromName, fromAddress, replyTo } = config;
  if (typeof host !== 'string' || !host.trim() || !Number.isInteger(port) || port < 1 || port > 65535
    || typeof secure !== 'boolean' || typeof user !== 'string' || !user.trim() || typeof pass !== 'string' || !pass
    || fromName !== 'AccountPulse' || typeof fromAddress !== 'string' || fromAddress.toLowerCase() !== 'ap@motts.com.au'
    || replyTo !== 'ap@motts.com.au') {
    throw new Error('LIFECYCLE_EMAIL_INVALID_CONFIGURATION');
  }
  const transport = factory({
    host, port, secure, requireTLS: !secure, tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true },
    auth: { user, pass }, forceAuth: true,
    ...(host === 'ventraip.email' ? { authMethod: 'LOGIN' } : {}),
    connectionTimeout: 10_000, greetingTimeout: 10_000,
    socketTimeout: 30_000, disableFileAccess: true, disableUrlAccess: true, maxRecipients: 1,
    logger: false, debug: false
  });
  return {
    async send(notice: LifecycleEmailNotice): Promise<LifecycleEmailOutcome> {
      if (!bareMailbox(notice.recipient)) return { status: 'FAILED', failureCode: 'INVALID_RECIPIENT' };
      let rendered: RenderedLifecycleEmail;
      try {
        rendered = renderLifecycleEmail(notice);
      } catch {
        return { status: 'FAILED', failureCode: 'INVALID_TEMPLATE' };
      }
      try {
        const reply = await transport.sendMail({
          from: { name: fromName, address: fromAddress.toLowerCase() }, replyTo, to: notice.recipient, ...rendered
        });
        return classifyReply(reply, notice.recipient);
      } catch (error) {
        return classifyError(error);
      }
    }
  };
}
