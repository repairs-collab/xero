import { expect, it, vi } from 'vitest';
import type { ClaimedLifecycleEmail } from '@bc5000/db';
import type { LifecycleEmailNotice, LifecycleEmailOutcome } from '@bc5000/integrations/email';
import { createLifecycleEmailDispatchHandler } from './lifecycle-email-dispatch.js';

const now = new Date('2026-11-22T01:10:00Z');
const activatedAt = new Date('2026-11-22T01:00:00Z');
const notice = {
  recipient: 'admin@example.test', template: 'WORKSPACE_WELCOME' as const,
  templateVersion: 1, renderData: { organisationName: 'Waratah' }
};
const claim: ClaimedLifecycleEmail = {
  ...notice, id: 'outbox-1', claimToken: 'token-1', organisationId: 'org-1',
  idempotencyKey: 'welcome/1', sourceType: 'workspace', sourceId: 'workspace-1',
  status: 'SENDING', attempts: 1, availableAt: now, expiresAt: new Date('2026-11-23T01:10:00Z'),
  nextAttemptAt: null, cancellationRequestedAt: null, messageId: null, providerMessageId: null,
  lastFailureCode: null, lastAttemptedAt: now, sentAt: null, createdAt: now, updatedAt: now
};
const smtp = { host: 'mail.example.test', port: 465, secure: true, user: 'user', pass: 'pass',
  fromName: 'AccountPulse', fromAddress: 'ap@motts.com.au', replyTo: 'ap@motts.com.au' };
const config = { smtp, activatedAt };
const sent = { status: 'SENT', messageId: '<msg@motts.com.au>' } as const;
const token = { id: 'outbox-1', claimToken: 'token-1', now };

function setup(rows: ClaimedLifecycleEmail[] = [claim], enabled = true, cutoff = activatedAt) {
  const repository = {
    expireDue: vi.fn().mockResolvedValue(1),
    quarantineStaleSending: vi.fn().mockResolvedValue(1),
    claimNext: vi.fn(() => Promise.resolve(rows.shift() ?? null)),
    recordSent: vi.fn().mockResolvedValue(true),
    recordRetry: vi.fn().mockResolvedValue(true),
    recordFailed: vi.fn().mockResolvedValue(true),
    recordUnknown: vi.fn().mockResolvedValue(true)
  };
  const send = vi.fn<(notice: LifecycleEmailNotice) => Promise<LifecycleEmailOutcome>>().mockResolvedValue(sent);
  const createClient = vi.fn(() => ({ send }));
  const clock = { now: vi.fn(() => now) };
  const run = createLifecycleEmailDispatchHandler({
    repository, config: enabled ? { ...config, activatedAt: cutoff } : null, createClient, clock
  });
  return { run, repository, send, createClient, clock };
}

it('expires due notices and quarantines stale sends while disabled without claiming or constructing SMTP', async () => {
  const { run, repository, createClient } = setup([claim], false);
  await run();
  expect(repository.expireDue).toHaveBeenCalledWith({ now });
  expect(repository.quarantineStaleSending).toHaveBeenCalledWith({
    now, staleBefore: new Date('2026-11-22T00:55:00Z')
  });
  expect(repository.claimNext).not.toHaveBeenCalled();
  expect(createClient).not.toHaveBeenCalled();
});

it('does not construct an SMTP client or claim notices before the configured activation', async () => {
  const { run, repository, createClient } = setup([claim], true, new Date('2026-11-22T01:15:00Z'));
  await run();
  expect(repository.claimNext).not.toHaveBeenCalled();
  expect(createClient).not.toHaveBeenCalled();
});

it.each([null, 'queue-1'])('records acceptance with provider message ID %s', async (providerMessageId) => {
  const { run, repository, send, clock } = setup();
  send.mockResolvedValue(providerMessageId === null ? sent : { ...sent, providerMessageId });
  const completedAt = new Date('2026-11-22T01:10:05Z');
  clock.now.mockReturnValueOnce(now).mockReturnValueOnce(now).mockReturnValue(completedAt);
  await run();
  expect(repository.expireDue).toHaveBeenCalledBefore(repository.claimNext);
  expect(repository.claimNext).toHaveBeenNthCalledWith(1, {
    now, staleBefore: new Date('2026-11-22T00:55:00Z'), activatedAt
  });
  expect(send).toHaveBeenCalledWith(notice);
  expect(repository.recordSent).toHaveBeenCalledWith({ ...token, now: completedAt, messageId: '<msg@motts.com.au>', providerMessageId });
});

it.each([[1, '01:11'], [2, '01:15'], [3, '01:25'], [4, '02:10']] as const)(
  'defers a known temporary failure on attempt %i until %s UTC', async (attempts, time) => {
    const { run, repository, send } = setup([{ ...claim, attempts }]);
    send.mockResolvedValue({ status: 'RETRY', failureCode: 'SMTP_TEMPORARY_REJECTION' });
    await run();
    expect(repository.recordRetry).toHaveBeenCalledWith({ ...token, failureCode: 'SMTP_TEMPORARY_REJECTION',
      nextAttemptAt: new Date('2026-11-22T' + time + ':00Z') });
  }
);

it('records a fifth temporary failure as terminal', async () => {
  const { run, repository, send } = setup([{ ...claim, attempts: 5 }]);
  send.mockResolvedValue({ status: 'RETRY', failureCode: 'SMTP_AUTH_FAILURE' });
  await run();
  expect(repository.recordFailed).toHaveBeenCalledWith({ ...token, failureCode: 'SMTP_AUTH_FAILURE' });
  expect(repository.recordRetry).not.toHaveBeenCalled();
});

it.each(['INVALID_TEMPLATE', 'SMTP_PERMANENT_REJECTION'] as const)('records %s as permanent', async (failureCode) => {
  const { run, repository, send } = setup();
  send.mockResolvedValue({ status: 'FAILED', failureCode });
  await run();
  expect(repository.recordFailed).toHaveBeenCalledWith({ ...token, failureCode });
  expect(repository.recordRetry).not.toHaveBeenCalled();
});

it('completes maintenance before reporting invalid SMTP configuration and leaves pending rows unclaimed', async () => {
  const { run, repository, send, createClient } = setup([claim, { ...claim, id: 'next' }]);
  createClient.mockImplementation(() => { throw new Error('private configuration'); });
  await expect(run()).rejects.toThrow(/^LIFECYCLE_EMAIL_INVALID_CONFIGURATION$/);
  expect(repository.claimNext).not.toHaveBeenCalled();
  expect(repository.recordFailed).not.toHaveBeenCalled();
  expect(repository.expireDue).toHaveBeenCalledBefore(createClient);
  expect(repository.quarantineStaleSending).toHaveBeenCalledBefore(createClient);
  expect(send).not.toHaveBeenCalled();
});

it('does not claim a row when the queue job has already been aborted', async () => {
  const { run, repository } = setup();
  await run({}, { signal: AbortSignal.abort() });
  expect(repository.claimNext).not.toHaveBeenCalled();
});

it.each([
  { reason: 'abort', elapsed: '01:10:02', retry: '01:10:03', fenced: false },
  { reason: 'budget', elapsed: '01:11:15', retry: '01:11:16', fenced: false },
  { reason: 'expiry', elapsed: '01:10:04', retry: '01:10:05', fenced: false },
  { reason: 'expiry', elapsed: '01:10:05', retry: '01:10:06', fenced: false },
  { reason: 'abort', elapsed: '01:10:02', retry: '01:10:03', fenced: true }
])('releases without sending when a claim resolves at $elapsed after $reason (claim lost: $fenced)', async ({
  reason, elapsed, retry, fenced
}) => {
  const controller = new AbortController();
  const { run, repository, send, clock } = setup();
  const started = Promise.withResolvers<void>();
  const pending = Promise.withResolvers<ClaimedLifecycleEmail>();
  repository.claimNext.mockImplementationOnce(() => {
    started.resolve();
    return pending.promise;
  });
  repository.recordRetry.mockResolvedValue(!fenced);
  const running = run({}, { signal: controller.signal });
  await started.promise;
  const returnedAt = new Date('2026-11-22T' + elapsed + 'Z');
  clock.now.mockReturnValue(returnedAt);
  if (reason === 'abort') controller.abort();
  pending.resolve(reason === 'expiry' ? { ...claim, expiresAt: new Date('2026-11-22T01:10:04Z') } : claim);
  if (fenced) await expect(running).rejects.toThrow(/^LIFECYCLE_EMAIL_CLAIM_LOST$/);
  else await running;
  expect(send).not.toHaveBeenCalled();
  expect(repository.recordRetry).toHaveBeenCalledWith({
    ...token, now: returnedAt, failureCode: 'JOB_CANCELLED_BEFORE_SUBMISSION',
    nextAttemptAt: new Date('2026-11-22T' + retry + 'Z')
  });
  expect(repository.claimNext).toHaveBeenCalledOnce();
});

it('finishes recording an in-flight send and stops before claiming again when the queue aborts', async () => {
  const controller = new AbortController();
  const { run, repository, send } = setup([claim, { ...claim, id: 'next' }]);
  send.mockImplementationOnce(() => {
    controller.abort();
    return Promise.resolve(sent);
  });
  await run({}, { signal: controller.signal });
  expect(repository.recordSent).toHaveBeenCalledOnce();
  expect(repository.claimNext).toHaveBeenCalledOnce();
});

it('leaves the next notice pending when a slow send consumes the 75-second claim budget', async () => {
  const { run, repository, send, clock } = setup([claim, { ...claim, id: 'next' }]);
  send.mockImplementationOnce(() => {
    clock.now.mockReturnValue(new Date('2026-11-22T01:11:15Z'));
    return Promise.resolve(sent);
  });
  await run();
  expect(repository.recordSent).toHaveBeenCalledOnce();
  expect(repository.claimNext).toHaveBeenCalledOnce();
});

it.each([true, false])('quarantines ambiguous delivery without retaining provider details (throws %s)', async (throws) => {
  const { run, repository, send } = setup();
  if (throws) send.mockRejectedValue(new Error('private SMTP credential and message body'));
  else send.mockResolvedValue({ status: 'UNKNOWN', failureCode: 'SMTP_ACCEPTANCE_UNCONFIRMED' });
  await run();
  expect(repository.recordUnknown).toHaveBeenCalledWith({
    ...token, failureCode: throws ? 'SMTP_SUBMISSION_UNCERTAIN' : 'SMTP_ACCEPTANCE_UNCONFIRMED'
  });
  expect(repository.recordRetry).not.toHaveBeenCalled();
});

it('processes up to twenty rows, settling each result before claiming another', async () => {
  const rows = Array.from({ length: 21 }, (_, i) => ({ ...claim, id: String(i), claimToken: 'token-' + i }));
  const { run, repository, send } = setup(rows);
  await run();
  expect(repository.claimNext).toHaveBeenCalledTimes(20);
  expect(send).toHaveBeenCalledTimes(20);
  expect(repository.recordSent).toHaveBeenCalledTimes(20);
  for (let i = 1; i < 20; i++) {
    expect(repository.recordSent.mock.invocationCallOrder[i - 1]).toBeLessThan(repository.claimNext.mock.invocationCallOrder[i]!);
  }
});

it.each([true, false])('stops without resending when an outcome write fails (fenced %s)', async (fenced) => {
  const { run, repository, send } = setup([claim, { ...claim, id: 'next' }]);
  if (fenced) repository.recordSent.mockResolvedValue(false);
  else repository.recordSent.mockRejectedValue(new Error('sensitive SQL details'));
  await expect(run()).rejects.toThrow(fenced ? /^LIFECYCLE_EMAIL_CLAIM_LOST$/ : /^LIFECYCLE_EMAIL_OUTCOME_WRITE_FAILED$/);
  expect(send).toHaveBeenCalledOnce();
  expect(repository.claimNext).toHaveBeenCalledOnce();
  expect(repository.recordRetry).not.toHaveBeenCalled();
  expect(repository.recordUnknown).not.toHaveBeenCalled();
});
