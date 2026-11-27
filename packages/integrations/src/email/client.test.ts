import { expect, it, vi } from 'vitest';
import type { SMTPTransportOptions } from 'nodemailer/lib/smtp-transport';
import { createLifecycleEmailClient, type LifecycleEmailTransport } from '@bc5000/integrations/email';

const recipient = 'admin@example.test';
const config = {
  host: 'smtp.example.test', port: 587, secure: false, user: 'test-user', pass: 'test-password',
  fromName: 'AccountPulse', fromAddress: 'ap@motts.com.au', replyTo: 'ap@motts.com.au'
};
const notice = {
  recipient, template: 'WORKSPACE_WELCOME', templateVersion: 1, renderData: { organisationName: 'Example Ltd' }
};
const accepted = { accepted: ['ADMIN@example.test'], rejected: [], messageId: '<test-id@example.test>' };

function sendWith(transport: LifecycleEmailTransport) {
  return createLifecycleEmailClient(config, () => transport).send(notice);
}

it.each([false, true])('secures the SMTP connection with implicit TLS = %s', (secure) => {
  const factory = vi.fn<(options: SMTPTransportOptions) => LifecycleEmailTransport>()
    .mockReturnValue({ sendMail: vi.fn() });
  createLifecycleEmailClient({ ...config, secure, port: secure ? 465 : 587 }, factory);
  expect(factory).toHaveBeenCalledWith(expect.objectContaining({
    host: 'smtp.example.test', secure, requireTLS: !secure, forceAuth: true,
    tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true },
    auth: { user: 'test-user', pass: 'test-password' }, logger: false, debug: false,
    disableFileAccess: true, disableUrlAccess: true, maxRecipients: 1
  }));
  const [options] = factory.mock.calls[0]!;
  for (const key of ['connectionTimeout', 'greetingTimeout', 'socketTimeout'] as const) {
    expect(options[key]).toBeGreaterThan(0);
    expect(options[key]).toBeLessThanOrEqual(60_000);
  }
});

it('uses explicit LOGIN over implicit TLS for the VentraIP mail relay', () => {
  const factory = vi.fn<(options: SMTPTransportOptions) => LifecycleEmailTransport>()
    .mockReturnValue({ sendMail: vi.fn() });
  createLifecycleEmailClient({ ...config, host: 'ventraip.email', secure: true, port: 465 }, factory);
  expect(factory).toHaveBeenCalledWith(expect.objectContaining({
    host: 'ventraip.email', port: 465, secure: true, authMethod: 'LOGIN',
    tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true }
  }));
});

it('sends a single-recipient message with the configured sender and returns only the accepted message ID', async () => {
  const sendMail = vi.fn<LifecycleEmailTransport['sendMail']>()
    .mockResolvedValue({ ...accepted, response: '250 private payload' });
  const client = createLifecycleEmailClient({ ...config, fromAddress: 'AP@Motts.com.au' }, () => ({ sendMail }));
  expect(await client.send(notice)).toEqual({ status: 'SENT', messageId: '<test-id@example.test>' });
  expect(sendMail).toHaveBeenCalledOnce();
  const [message] = sendMail.mock.calls[0]!;
  expect(message.from).toEqual({ name: 'AccountPulse', address: 'ap@motts.com.au' });
  expect(message.replyTo).toBe('ap@motts.com.au');
  expect(message.to).toBe(recipient);
  expect(message.subject).toContain('AccountPulse');
  expect(message.text).toContain('Example Ltd');
  expect(message.html).toContain('<p>');
});

it.each(['<11223344-5566-7788-99aa-bbccddeeff00@host>', '<abc_1.d2-X@mail-01.example>'])(
  'records the optional server-assigned ID alongside a generated Message-ID', async (messageId) => {
    const sendMail = vi.fn().mockResolvedValue({ ...accepted, messageId, serverMessageId: ' queue-123 ' });
    expect(await sendWith({ sendMail })).toEqual({ status: 'SENT', messageId, providerMessageId: 'queue-123' });
  }
);

it.each([
  'queue-123', 'a@b', '<a@b@c>', '<@b>', '<a@>', '<<a>@b>', '<a b@c>',
  '<a..b@host>', '<.a@host>', '<a.@host>', '<a,b@host>', '<a+b@host>',
  '<a@.host>', '<a@host.>', '<a@x..host>', '<a@x.-host>', '<a@x-.host>', '<a@x_y.host>',
  '<café@b>', '<a@b> ', ' <a@b>', '<a@b>\n', `<${'a'.repeat(509)}@b>`
])('quarantines accepted mail with an invalid RFC Message-ID', async (messageId) => {
  const sendMail = vi.fn().mockResolvedValue({ ...accepted, messageId, serverMessageId: 'queue-123' });
  expect(await sendWith({ sendMail })).toEqual({ status: 'UNKNOWN', failureCode: 'SMTP_ACCEPTANCE_UNCONFIRMED' });
});

it('accepts a canonical 512-character RFC Message-ID', async () => {
  const messageId = `<${'a'.repeat(508)}@b>`;
  expect(await sendWith({ sendMail: vi.fn().mockResolvedValue({ ...accepted, messageId }) }))
    .toEqual({ status: 'SENT', messageId });
});

it.each([' ', 'ID\r\nprivate', 'x'.repeat(513)])('omits an unusable optional server ID after explicit acceptance', async (serverMessageId) => {
  const sendMail = vi.fn().mockResolvedValue({ ...accepted, serverMessageId });
  expect(await sendWith({ sendMail })).toEqual({ status: 'SENT', messageId: '<test-id@example.test>' });
});

it.each([
  { fromName: 'Other Account' }, { fromAddress: 'other@motts.com.au' },
  { replyTo: 'other@motts.com.au' }, { replyTo: 'AP@motts.com.au' },
  { fromName: '' }, { fromName: 'AccountPulse\r\nBcc: other@example.test' },
  { fromAddress: 'bad@example.test,second@example.test' }, { replyTo: '\r\nap@motts.com.au' },
  { fromAddress: '' }, { host: '' }, { port: 0 }, { user: '' }, { pass: '' }
])('rejects invalid sender or SMTP configuration before opening a connection', (bad) => {
  const factory = vi.fn();
  expect(() => createLifecycleEmailClient({ ...config, ...bad }, factory)).toThrow(/^LIFECYCLE_EMAIL_INVALID_CONFIGURATION$/);
  expect(factory).not.toHaveBeenCalled();
});

it.each([
  { recipient: 'a@example.test, b@example.test' }, { recipient: 'a@example.test\r\nBcc: b@example.test' },
  { recipient: 'Someone <a@example.test>' }, { recipient: 'a@example.test; b@example.test' }
])('fails an unsafe recipient before transport', async (bad) => {
  const sendMail = vi.fn();
  const client = createLifecycleEmailClient(config, () => ({ sendMail }));
  expect(await client.send({ ...notice, ...bad })).toEqual({ status: 'FAILED', failureCode: 'INVALID_RECIPIENT' });
  expect(sendMail).not.toHaveBeenCalled();
});

it('fails invalid render data without submitting it', async () => {
  const sendMail = vi.fn();
  const client = createLifecycleEmailClient(config, () => ({ sendMail }));
  expect(await client.send({ ...notice, renderData: { providerPayload: 'private' } }))
    .toEqual({ status: 'FAILED', failureCode: 'INVALID_TEMPLATE' });
  expect(sendMail).not.toHaveBeenCalled();
});

it.each([
  { ...accepted, accepted: [] }, { ...accepted, accepted: ['other@example.test'] },
  { ...accepted, accepted: [recipient, 'other@example.test'] }, { ...accepted, rejected: [recipient] },
  { ...accepted, messageId: ' ' }, { ...accepted, messageId: 'x'.repeat(513) },
  { ...accepted, messageId: '', serverMessageId: 'ABC-123' },
  { ...accepted, accepted: [], serverMessageId: 'ABC-123' },
  { ...accepted, messageId: '<ok@example.test>\r\nprivate' }, {},
  { ...accepted, rejected: ['other@example.test'] },
  { ...accepted, rejectedErrors: [{ recipient, responseCode: 550 }] }
])('quarantines incomplete or inconsistent acceptance evidence', async (info) => {
  expect(await sendWith({ sendMail: vi.fn().mockResolvedValue(info) }))
    .toEqual({ status: 'UNKNOWN', failureCode: 'SMTP_ACCEPTANCE_UNCONFIRMED' });
});

it.each([
  [450, 'RETRY', 'SMTP_TEMPORARY_REJECTION'], [550, 'FAILED', 'SMTP_PERMANENT_REJECTION']
] as const)('handles recipient rejection with SMTP code %i', async (responseCode, status, failureCode) => {
  const info = { accepted: [], rejected: [recipient], messageId: '<ignored>',
    rejectedErrors: [{ recipient, command: 'RCPT TO', responseCode, response: 'private response' }] };
  expect(await sendWith({ sendMail: vi.fn().mockResolvedValue(info) })).toEqual({ status, failureCode });
});

it.each([undefined, 'CONN', 'QUIT', 'RSET'])('quarantines a recipient error in an unproven phase', async (command) => {
  const sendMail = vi.fn().mockResolvedValue({
    accepted: [], rejected: [recipient], rejectedErrors: [{ recipient, command, responseCode: 550 }]
  });
  expect(await sendWith({ sendMail })).toEqual({ status: 'UNKNOWN', failureCode: 'SMTP_ACCEPTANCE_UNCONFIRMED' });
});

it('quarantines a recipient rejection without a verified rejection code', async () => {
  expect(await sendWith({ sendMail: vi.fn().mockResolvedValue({
    accepted: [], rejected: [recipient], rejectedErrors: [{ recipient: 'someone@example.test', responseCode: 550 }]
  }) })).toEqual({ status: 'UNKNOWN', failureCode: 'SMTP_ACCEPTANCE_UNCONFIRMED' });
});

it.each([
  [{ command: 'RCPT TO', responseCode: 450 }, 'RETRY', 'SMTP_TEMPORARY_REJECTION'],
  [{ command: 'DATA', responseCode: 451 }, 'RETRY', 'SMTP_TEMPORARY_REJECTION'],
  [{ command: 'RCPT TO', code: 'EENVELOPE', responseCode: 550 }, 'FAILED', 'SMTP_PERMANENT_REJECTION'],
  [{ command: 'DATA', responseCode: 554 }, 'FAILED', 'SMTP_PERMANENT_REJECTION'],
  [{ command: 'AUTH PLAIN', code: 'EAUTH', responseCode: 535 }, 'FAILED', 'SMTP_PERMANENT_REJECTION'],
  [{ command: 'AUTH LOGIN', code: 'EAUTH', responseCode: 454 }, 'RETRY', 'SMTP_TEMPORARY_REJECTION'],
  [{ command: 'AUTH PLAIN', code: 'ESOCKET' }, 'RETRY', 'SMTP_AUTH_FAILURE'],
  [{ command: 'EHLO', responseCode: 550 }, 'FAILED', 'SMTP_PERMANENT_REJECTION'],
  [{ command: 'HELO', responseCode: 451 }, 'RETRY', 'SMTP_TEMPORARY_REJECTION'],
  [{ command: 'STARTTLS', responseCode: 454 }, 'RETRY', 'SMTP_TEMPORARY_REJECTION'],
  [{ command: 'MAIL FROM', responseCode: 550 }, 'FAILED', 'SMTP_PERMANENT_REJECTION'],
  [{ command: 'CONN', responseCode: 451 }, 'UNKNOWN', 'SMTP_SUBMISSION_UNCERTAIN'],
  [{ command: 'CONN', responseCode: 550 }, 'UNKNOWN', 'SMTP_SUBMISSION_UNCERTAIN'],
  [{ command: 'CONN', code: 'EAUTH', responseCode: 451 }, 'UNKNOWN', 'SMTP_SUBMISSION_UNCERTAIN'],
  [{ code: 'EAUTH', responseCode: 550 }, 'UNKNOWN', 'SMTP_SUBMISSION_UNCERTAIN'],
  [{ command: 'UNRECOGNISED', responseCode: 451 }, 'UNKNOWN', 'SMTP_SUBMISSION_UNCERTAIN'],
  [{ command: 'UNRECOGNISED', responseCode: 550 }, 'UNKNOWN', 'SMTP_SUBMISSION_UNCERTAIN'],
  [{ command: 'RSET', responseCode: 451 }, 'UNKNOWN', 'SMTP_SUBMISSION_UNCERTAIN'],
  [{ code: 'EAUTH' }, 'RETRY', 'SMTP_AUTH_FAILURE'],
  [{ command: 'CONN', code: 'ESOCKET', originalCode: 'ECONNREFUSED' }, 'RETRY', 'SMTP_CONNECTION_FAILURE'],
  [{ command: 'CONN', code: 'ESOCKET', originalCode: 'ETIMEDOUT', syscall: 'connect' }, 'RETRY', 'SMTP_CONNECTION_FAILURE'],
  [{ code: 'EDNS' }, 'RETRY', 'SMTP_CONNECTION_FAILURE'],
  [{ command: 'STARTTLS', code: 'ETLS' }, 'RETRY', 'SMTP_CONNECTION_FAILURE'],
  [{ command: 'CONN', code: 'ETIMEDOUT', timeoutType: 'CONNECT_TIMEOUT' }, 'RETRY', 'SMTP_CONNECTION_FAILURE'],
  [{ command: 'CONN', code: 'ETIMEDOUT', timeoutType: 'GREETING_TIMEOUT' }, 'RETRY', 'SMTP_CONNECTION_FAILURE'],
  [{ command: 'CONN', code: 'ETIMEDOUT', timeoutType: 'UPGRADE_TIMEOUT' }, 'RETRY', 'SMTP_CONNECTION_FAILURE'],
  [{ command: 'RCPT TO', code: 'ECONNRESET' }, 'RETRY', 'SMTP_CONNECTION_FAILURE'],
  [{ command: 'DATA', code: 'ETIMEDOUT' }, 'UNKNOWN', 'SMTP_SUBMISSION_UNCERTAIN'],
  [{ command: 'DATA', code: 'ESOCKET' }, 'UNKNOWN', 'SMTP_SUBMISSION_UNCERTAIN'],
  [{ command: 'CONN', code: 'ECONNECTION' }, 'UNKNOWN', 'SMTP_SUBMISSION_UNCERTAIN'],
  [{ command: 'CONN', code: 'ESOCKET', originalCode: 'ECONNRESET' }, 'UNKNOWN', 'SMTP_SUBMISSION_UNCERTAIN'],
  [{ command: 'CONN', code: 'ESOCKET', originalCode: 'ENETUNREACH', syscall: 'write' }, 'UNKNOWN', 'SMTP_SUBMISSION_UNCERTAIN'],
  [{ command: 'QUIT', responseCode: 421 }, 'UNKNOWN', 'SMTP_SUBMISSION_UNCERTAIN'],
  [{ command: 'CONN', code: 'ETIMEDOUT', timeoutType: 'SOCKET_TIMEOUT' }, 'UNKNOWN', 'SMTP_SUBMISSION_UNCERTAIN'],
  [{ code: 'ETIMEDOUT' }, 'UNKNOWN', 'SMTP_SUBMISSION_UNCERTAIN'],
  [{ code: 'PROCESS_TERMINATED' }, 'UNKNOWN', 'SMTP_SUBMISSION_UNCERTAIN']
] as const)('classifies %j as %s and redacts provider details', async (fields, status, failureCode) => {
  const error = Object.assign(new Error('private SMTP error'), fields, { response: 'private provider payload' });
  expect(await sendWith({ sendMail: vi.fn().mockRejectedValue(error) })).toEqual({ status, failureCode });
});
