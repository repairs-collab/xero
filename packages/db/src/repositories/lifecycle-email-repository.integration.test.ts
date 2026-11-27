import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, expect, it } from 'vitest';
import * as api from '../index.js';
import { billingCases, lifecycleEmailOutbox, memberships, organisations, transactionalEmailOutbox, users } from '../schema/index.js';

const client = api.createDatabase(process.env.DATABASE_URL ?? 'postgres://bc5000:bc5000@localhost:5432/bc5000');
const now = new Date('2000-01-01T00:00:00Z');
const later = (seconds: number) => new Date(now.getTime() + seconds * 1000);
const tenants: string[] = [];
const userIds: string[] = [];
let organisationId: string;
let repository: api.PostgresLifecycleEmailRepository;

async function tenant() {
  const id = randomUUID();
  await client.db.insert(organisations).values({ id, name: 'Mail test', xeroOrganisationId: id, timeZone: 'Australia/Sydney', baseCurrency: 'AUD' });
  tenants.push(id);
  return id;
}

function notice(overrides: Partial<api.EnqueueLifecycleEmailInput> = {}): api.EnqueueLifecycleEmailInput {
  return {
    organisationId, recipient: '  Admin@Example.com ', template: 'WORKSPACE_WELCOME', templateVersion: 1,
    renderData: { organisationName: 'Mail test' }, idempotencyKey: randomUUID(),
    sourceType: 'WORKSPACE', sourceId: organisationId, availableAt: now, expiresAt: later(100), ...overrides
  };
}
const claim = (at = now) => repository.claimNext({ now: at, staleBefore: later(-100), activatedAt: later(-100) });
const row = (id: string) => client.db.query.lifecycleEmailOutbox.findFirst({ where: eq(lifecycleEmailOutbox.id, id) });
beforeEach(async () => {
  repository = new api.PostgresLifecycleEmailRepository(client.db);
  organisationId = await tenant();
});
afterEach(async () => {
  await client.db.transaction(async (tx) => {
    if (tenants.length) {
      await tx.delete(transactionalEmailOutbox).where(inArray(transactionalEmailOutbox.organisationId, tenants));
      await tx.delete(organisations).where(inArray(organisations.id, tenants));
    }
    if (userIds.length) await tx.delete(users).where(inArray(users.id, userIds));
  });
  tenants.length = 0;
  userIds.length = 0;
});
afterAll(() => client.pool.end());

it('claims only rows created and due after activation, including when old work was queued late', async () => {
  const historical = notice({ availableAt: later(-20) });
  const held = notice({ availableAt: later(1) });
  const newNotice = notice({ availableAt: later(2) });
  await repository.enqueue(historical);
  await repository.enqueue(held);
  await repository.enqueue(newNotice);
  await client.db.update(lifecycleEmailOutbox)
    .set({ createdAt: later(-5) })
    .where(eq(lifecycleEmailOutbox.idempotencyKey, held.idempotencyKey));
  const activatedAt = later(0);
  const options = { now: later(5), staleBefore: later(-100), activatedAt };
  expect(await repository.claimNext(options)).toMatchObject({ idempotencyKey: newNotice.idempotencyKey });
  expect(await repository.claimNext(options)).toBeNull();
});

it('enqueues exactly once per tenant/key, normalises the mailbox, and rolls back with its caller', async () => {
  const input = notice();
  const duplicate = { ...input, template: 'ONBOARDING_COMPLETED' as const, recipient: 'other@example.com' };
  const inserted = await Promise.all([repository.enqueue(input), repository.enqueue(input)]);
  expect(inserted.sort()).toEqual([false, true]);
  expect(await repository.enqueue(duplicate)).toBe(false);
  expect(await repository.enqueue({ ...input, organisationId: await tenant() })).toBe(true);
  await expect(client.db.transaction(async (tx) => {
    await new api.PostgresLifecycleEmailRepository(tx).enqueue(notice());
    throw new Error('rollback');
  })).rejects.toThrow('rollback');
  const rows = await client.db.select().from(lifecycleEmailOutbox).where(eq(lifecycleEmailOutbox.organisationId, organisationId));
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ status: 'PENDING', attempts: 0, recipient: 'admin@example.com', template: 'WORKSPACE_WELCOME' });
  await expect(repository.enqueue(notice({ recipient: 'a@example.com,b@example.com' }))).rejects.toThrow();
});

it('filters disabled users, disabled memberships, other tenants, invalid addresses and duplicate admin mailboxes', async () => {
  const other = await tenant();
  const address = `admin-${randomUUID()}@example.com`;
  const members = [
    { email: address, tenant: organisationId, role: 'ADMIN' },
    { email: ` ${address.toUpperCase()} `, tenant: organisationId, role: 'ADMIN' },
    { email: 'bad-email', tenant: organisationId, role: 'ADMIN' },
    { email: `u-${address}`, tenant: organisationId, role: 'ADMIN', disabledUser: true },
    { email: `m-${address}`, tenant: organisationId, role: 'ADMIN', disabledMembership: true },
    { email: `other-${address}`, tenant: other, role: 'ADMIN' },
    { email: `op-${address}`, tenant: organisationId, role: 'OPERATOR' }
  ] as const;
  for (const m of members) {
    const id = randomUUID();
    await client.db.insert(users).values({
      id, email: m.email === 'bad-email' ? `bad-${id}` : m.email,
      cognitoSubject: id, displayName: 'Mail test', disabledAt: 'disabledUser' in m ? now : null
    });
    userIds.push(id);
    await client.db.insert(memberships).values({
      organisationId: m.tenant, userId: id, role: m.role, disabledAt: 'disabledMembership' in m ? now : null
    });
  }
  expect(await api.listLifecycleEmailAdminRecipients(client.db, organisationId)).toEqual([address]);
});

it.each(['disabled membership', 'disabled account', 'changed email', 'changed role'] as const)(
  'suppresses an already claimed administrator notice after a %s',
  async (change) => {
    const userId = randomUUID();
    const address = 'admin-' + userId + '@example.com';
    await client.db.insert(users).values({
      id: userId, email: ' ' + address.toUpperCase() + ' ', cognitoSubject: userId, displayName: 'Mail test'
    });
    userIds.push(userId);
    await client.db.insert(memberships).values({
      organisationId, userId, role: 'ADMIN'
    });
    await repository.enqueue(notice({ recipient: address }));
    const sending = (await claim())!;
    const input = { id: sending.id, claimToken: sending.claimToken, now };
    expect(await repository.checkRecipientForDelivery(input)).toBe('READY');

    if (change === 'disabled account' || change === 'changed email') {
      await client.db.update(users).set(change === 'disabled account'
        ? { disabledAt: now }
        : { email: 'other-' + address }
      ).where(eq(users.id, userId));
    } else {
      await client.db.insert(memberships).values({ organisationId: await tenant(), userId, role: 'ADMIN' });
      await client.db.update(memberships).set(change === 'disabled membership'
        ? { disabledAt: now }
        : { role: 'OPERATOR' }
      ).where(and(eq(memberships.organisationId, organisationId), eq(memberships.userId, userId)));
    }

    expect(await repository.checkRecipientForDelivery(input)).toBe('RECIPIENT_ACCESS_REVOKED');
    expect(await repository.recordSuppressed({ ...input, failureCode: 'RECIPIENT_ACCESS_REVOKED' })).toBe(true);
    expect(await row(sending.id)).toMatchObject({
      status: 'CANCELLED', claimToken: null, lastFailureCode: 'RECIPIENT_ACCESS_REVOKED', sentAt: null
    });
    expect(await repository.checkRecipientForDelivery(input)).toBe('CLAIM_LOST');
  }
);

it.each([
  ['EXPORT_DELIVERED', { organisationName: 'Mail test', requestId: 'request', completedAt: '2026-11-22' }],
  ['PRIVACY_REQUEST_RECEIVED', { organisationName: 'Mail test', requestId: 'request', requestType: 'EXPORT', targetResponseAt: '2026-11-22' }]
] as const)('allows a verified %s requester without organisation membership', async (template, renderData) => {
  await repository.enqueue(notice({ recipient: 'requester@example.com', template, renderData, sourceType: 'DATA_REQUEST' }));
  const sending = (await claim())!;
  expect(await repository.checkRecipientForDelivery({
    id: sending.id, claimToken: sending.claimToken
  })).toBe('READY');
});

it('creates a stable recipient key without exposing the mailbox', () => {
  const mailbox = 'admin@example.com';
  const key = api.lifecycleEmailRecipientKey(` ${mailbox.toUpperCase()} `);
  expect(key).toBe(api.lifecycleEmailRecipientKey(mailbox));
  expect(key).not.toContain(mailbox);
  expect(key).toMatch(/^[a-f0-9]{64}$/);
  expect(() => api.lifecycleEmailRecipientKey('not-an-email')).toThrow(
    'LIFECYCLE_EMAIL_INVALID_RECIPIENT'
  );
});

it('claims at most once across concurrent workers, skips scheduled rows and fences acceptance', async () => {
  await repository.enqueue(notice({ availableAt: later(20) }));
  await repository.enqueue(notice());
  const results = await Promise.all([claim(), claim()]);
  const claimed = results.find((item) => item !== null)!;
  expect(results.filter(Boolean)).toHaveLength(1);
  expect(claimed).toMatchObject({ attempts: 1, status: 'SENDING', lastAttemptedAt: now });
  const outcome = { id: claimed.id, now: later(1), claimToken: claimed.claimToken, messageId: '<123@example.com>', providerMessageId: 'queue-123' };
  expect(await repository.recordSent({ ...outcome, claimToken: randomUUID() })).toBe(false);
  expect(await repository.recordSent(outcome)).toBe(true);
  expect(await repository.recordFailed({ ...outcome, failureCode: 'SMTP_REJECTED' })).toBe(false);
  expect(await row(claimed.id)).toMatchObject({ status: 'SENT', sentAt: later(1), messageId: '<123@example.com>', providerMessageId: 'queue-123', claimToken: null });
});

it('retries only at the scheduled time and rejects attempts to finalise the next claim with an earlier token', async () => {
  await repository.enqueue(notice());
  const first = (await claim())!;
  const outcome = { id: first.id, now: later(1), claimToken: first.claimToken, failureCode: 'SMTP_TEMPORARY' };
  expect(await repository.recordRetry({ ...outcome, nextAttemptAt: later(15) })).toBe(true);
  expect(await claim(later(14))).toBeNull();
  const second = (await claim(later(15)))!;
  expect(second).toMatchObject({ id: first.id, attempts: 2 });
  expect(second.claimToken).not.toBe(first.claimToken);
  expect(await repository.recordUnknown(outcome)).toBe(false);
  expect(await repository.recordFailed({ ...outcome, claimToken: second.claimToken, now: later(16) })).toBe(true);
  expect(await claim(later(18))).toBeNull();
  expect(await row(first.id)).toMatchObject({ status: 'FAILED', lastFailureCode: 'SMTP_TEMPORARY' });
});

it('continues to the next due message while another transaction holds the first row lock', async () => {
  const first = notice();
  const second = notice({ availableAt: later(1) });
  await repository.enqueue(first);
  await repository.enqueue(second);
  await client.db.transaction(async (lockingTransaction) => {
    await lockingTransaction.select({ id: lifecycleEmailOutbox.id }).from(lifecycleEmailOutbox)
      .where(eq(lifecycleEmailOutbox.idempotencyKey, first.idempotencyKey)).for('update');
    const claimed = await client.db.transaction(async (workerTransaction) => {
      await workerTransaction.execute(sql`set local lock_timeout = '2s'`);
      return new api.PostgresLifecycleEmailRepository(workerTransaction)
        .claimNext({ now: later(1), staleBefore: later(-100), activatedAt: later(-100) });
    });
    expect(claimed?.idempotencyKey).toBe(second.idempotencyKey);
  });
});

it('rejects unsafe persisted render payloads and inconsistent delivery state', async () => {
  const input = { ...notice(), recipient: 'admin@example.com' };
  for (const renderData of [[1], { payload: { provider: 'nested' } }, { payload: [1, 2] }]) {
    await expect(client.db.insert(lifecycleEmailOutbox).values({
      ...input, renderData: sql`${JSON.stringify(renderData)}::jsonb`
    })).rejects.toMatchObject({ cause: { code: '23514', constraint: 'lifecycle_email_render_ck' } });
  }
  for (const state of [{ status: 'SENDING' }, { status: 'SENT' }, { status: 'RETRY' }] as const) {
    await expect(client.db.insert(lifecycleEmailOutbox).values({ ...input, ...state }))
      .rejects.toMatchObject({ cause: { code: '23514' } });
  }
});

it.each([
  ['WORKSPACE_WELCOME', { organisationName: 'Test' }],
  ['ONBOARDING_COMPLETED', { organisationName: 'Test' }],
  ['PAYMENT_CONFIRMED', { organisationName: 'Test', billingCadence: 'monthly' }],
  ['SMS_USAGE_WARNING', { organisationName: 'Test', committedParts: 80, includedParts: 100, warningPercent: 80, billingPeriodEnd: '2026-10-31' }],
  ['PAYMENT_FAILED', { organisationName: 'Test', amountMinor: 100, currency: 'aud', recoveryEndsAt: '2026-10-31' }],
  ['PAYMENT_RECOVERED', { organisationName: 'Test' }],
  ['CANCELLATION_SCHEDULED', { organisationName: 'Test', effectiveAt: '2026-10-31' }],
  ['CANCELLATION_EFFECTIVE', { organisationName: 'Test', cancelledAt: '2026-10-31', dataRetainedUntil: '2026-11-30' }],
  ['EXPORT_DELIVERED', { organisationName: 'Test', requestId: 'request', completedAt: '2026-10-31' }],
  ['PRIVACY_REQUEST_RECEIVED', { organisationName: 'Test', requestId: 'request', requestType: 'EXPORT', targetResponseAt: '2026-10-31' }],
  ['PRIVACY_REQUEST_RECEIVED', { organisationName: 'Test', requestId: 'request', requestType: 'DELETION', targetResponseAt: '2026-10-31' }]
] as const)('stores only allowed fields for %s version 1', async (template, renderData) => {
  expect(await repository.enqueue(notice({ template, renderData }))).toBe(true);
  const invalid = notice({ template, renderData: { ...renderData, stripePayload: 'must never be stored' } });
  await expect(repository.enqueue(invalid)).rejects.toThrow('LIFECYCLE_EMAIL_INVALID_RENDER_DATA');
  const persisted = await client.db.select({ data: lifecycleEmailOutbox.renderData }).from(lifecycleEmailOutbox)
    .where(eq(lifecycleEmailOutbox.organisationId, organisationId));
  expect(persisted).toEqual([{ data: renderData }]);
});

it('rejects unregistered versions and fields belonging to a different template', async () => {
  await expect(repository.enqueue(notice({ templateVersion: 2 }))).rejects.toThrow('LIFECYCLE_EMAIL_UNSUPPORTED_TEMPLATE');
  await expect(repository.enqueue(notice({ renderData: { organisationName: 'Test', amountMinor: 100 } })))
    .rejects.toThrow('LIFECYCLE_EMAIL_INVALID_RENDER_DATA');
});

it.each(['amountMinor', 'currency'])('rejects %s when recording a payment recovery notice', async (field) => {
  await expect(repository.enqueue(notice({ template: 'PAYMENT_RECOVERED', renderData: { organisationName: 'Test', [field]: 'unverified' } })))
    .rejects.toThrow('LIFECYCLE_EMAIL_INVALID_RENDER_DATA');
});

it.each([{}, { providerMessageId: null }])('records explicit acceptance with the header Message-ID when SMTP supplies no provider ID', async (evidence) => {
  await repository.enqueue(notice());
  const sending = (await claim())!;
  expect(await repository.recordSent({ id: sending.id, claimToken: sending.claimToken, now, messageId: '<stable@example.com>', ...evidence })).toBe(true);
  expect(await row(sending.id)).toMatchObject({ status: 'SENT', sentAt: now, messageId: '<stable@example.com>', providerMessageId: null });
});

it('rejects missing, blank, overlong or control-bearing identifier evidence without changing the claim', async () => {
  await repository.enqueue(notice());
  const sending = (await claim())!;
  const outcome = { id: sending.id, claimToken: sending.claimToken, now, messageId: '<valid@example.com>' };
  for (const messageId of [null, '', '   ', '<x\ny@example.com>', 'x'.repeat(513)]) {
    await expect(repository.recordSent({ ...outcome, messageId: messageId!, providerMessageId: 'queue-123' }))
      .rejects.toThrow('LIFECYCLE_EMAIL_INVALID_MESSAGE_ID');
    await expect(client.db.update(lifecycleEmailOutbox).set({ status: 'SENT', claimToken: null, sentAt: now, messageId, providerMessageId: 'queue-123' })
      .where(eq(lifecycleEmailOutbox.id, sending.id))).rejects.toMatchObject({ cause: { code: messageId?.length === 513 ? '22001' : '23514' } });
  }
  for (const providerMessageId of ['', '   ', 'queue\r123', 'q'.repeat(513)]) {
    await expect(repository.recordSent({ ...outcome, providerMessageId }))
      .rejects.toThrow('LIFECYCLE_EMAIL_INVALID_PROVIDER_MESSAGE_ID');
    await expect(client.db.update(lifecycleEmailOutbox).set({ status: 'SENT', claimToken: null, sentAt: now, messageId: outcome.messageId, providerMessageId })
      .where(eq(lifecycleEmailOutbox.id, sending.id))).rejects.toMatchObject({ cause: { code: providerMessageId.length === 513 ? '22001' : '23514' } });
  }
  for (const evidence of [{ providerMessageId: 'queue-123' }, { messageId: '<valid@example.com>' }]) {
    await expect(client.db.update(lifecycleEmailOutbox).set(evidence).where(eq(lifecycleEmailOutbox.id, sending.id)))
      .rejects.toMatchObject({ cause: { code: '23514' } });
  }
  expect(await row(sending.id)).toMatchObject({ status: 'SENDING', claimToken: sending.claimToken });
});

it.each(['repository', 'database'] as const)('requires a bracketed header Message-ID separately from a provider queue ID via the %s', async (writer) => {
  await repository.enqueue(notice());
  const sending = (await claim())!;
  const record = (messageId: string) => writer === 'repository'
    ? repository.recordSent({ id: sending.id, claimToken: sending.claimToken, now, messageId, providerMessageId: 'queue-123' })
    : client.db.update(lifecycleEmailOutbox)
      .set({ status: 'SENT', sentAt: now, claimToken: null, messageId, providerMessageId: 'queue-123' })
      .where(eq(lifecycleEmailOutbox.id, sending.id));
  for (const malformed of [
    'queue-123', 'local@example.com', '<@example.com>', '<local@>', '<local@@example.com>',
    '<<id@example.com>>', '<local@do>main>', '<space here@example.com>', ' <local@example.com>',
    '<local@do\tmain>', '<local@example.com>\n', '<a..b@example.test>', '<a,b@example.test>',
    '<.a@example.test>', '<a.@example.test>', '<a+b@example.test>', '<a@.example.test>',
    '<a@example.test.>', '<a@example..test>', '<a@-example.test>', '<a@example-.test>', '<a@some_host>'
  ]) {
    if (writer === 'repository') await expect(record(malformed)).rejects.toThrow('LIFECYCLE_EMAIL_INVALID_MESSAGE_ID');
    else await expect(record(malformed)).rejects.toMatchObject({ cause: { code: '23514', constraint: 'lifecycle_email_sent_ck' } });
  }
  const validId = '<42cb6bf2-d749-4a56-906f-c4c44b0033e2@host>';
  await record(validId);
  expect(await row(sending.id)).toMatchObject({
    status: 'SENT', messageId: validId, providerMessageId: 'queue-123'
  });
});

it('indexes tenant delivery statuses by creation time for owner monitoring', async () => {
  const { rows } = await client.pool.query<{ indexdef: string }>(
    "select indexdef from pg_indexes where schemaname = current_schema() and tablename = 'lifecycle_email_outbox'"
  );
  expect(rows.some(({ indexdef }) => indexdef.includes('(organisation_id, status, created_at)'))).toBe(true);
});

it.each([
  ['suppressed', 'CANCELLED'], ['retry', 'CANCELLED'], ['failed', 'CANCELLED'], ['sent', 'SENT'], ['unknown', 'UNKNOWN'], ['stale', 'UNKNOWN']
] as const)('honours recovery during an active send when its outcome is %s', async (result, status) => {
  const failure = notice({ sourceType: 'BILLING_EPISODE', sourceId: randomUUID(), template: 'PAYMENT_FAILED' });
  await repository.enqueue(failure);
  const sending = (await claim())!;
  const cancellation = { organisationId, sourceType: failure.sourceType, sourceId: failure.sourceId, template: failure.template, now: later(1) };
  expect(await repository.cancelUnsentForSource(cancellation)).toBe(1);
  expect(await repository.cancelUnsentForSource({ ...cancellation, now: later(2) })).toBe(0);
  expect(await row(sending.id)).toMatchObject({ status: 'SENDING', cancellationRequestedAt: later(1), claimToken: sending.claimToken });
  const outcome = { id: sending.id, claimToken: sending.claimToken, now: later(3), failureCode: 'SMTP_REJECTION' };
  if (result === 'suppressed') {
    expect(await repository.checkRecipientForDelivery(outcome)).toBe('NOTICE_CANCELLED_BEFORE_SUBMISSION');
    expect(await repository.recordSuppressed({
      ...outcome, failureCode: 'NOTICE_CANCELLED_BEFORE_SUBMISSION'
    })).toBe(true);
  }
  if (result === 'retry') expect(await repository.recordRetry({ ...outcome, nextAttemptAt: later(10) })).toBe(true);
  if (result === 'failed') expect(await repository.recordFailed(outcome)).toBe(true);
  if (result === 'sent') expect(await repository.recordSent({ ...outcome, messageId: '<id@example.com>' })).toBe(true);
  if (result === 'unknown') expect(await repository.recordUnknown(outcome)).toBe(true);
  if (result === 'stale') expect(await repository.claimNext({
    now: later(3), staleBefore: now, activatedAt: later(-100)
  })).toBeNull();
  expect(await row(sending.id)).toMatchObject({ status, nextAttemptAt: null, claimToken: null });
  expect(await claim(later(10))).toBeNull();
});

it('cancels expired unsent notices, including a retry whose next due time reaches expiry', async () => {
  await repository.enqueue(notice({ expiresAt: later(2) }));
  expect(await claim(later(2))).toBeNull();
  expect(await repository.expireDue({ now: later(2) })).toBe(1);
  await repository.enqueue(notice({ expiresAt: later(30) }));
  const sending = (await claim(later(3)))!;
  expect(await repository.recordRetry({ id: sending.id, claimToken: sending.claimToken, now: later(4), nextAttemptAt: later(30), failureCode: 'SMTP_TEMPORARY' })).toBe(true);
  expect(await row(sending.id)).toMatchObject({ status: 'CANCELLED', nextAttemptAt: null });
});

it('quarantines stale claims even after expiry and preserves all ambiguous outcomes across future claims', async () => {
  await repository.enqueue(notice({ expiresAt: later(2) }));
  const stale = (await claim())!;
  expect(await repository.expireDue({ now: later(2) })).toBe(0);
  expect(await repository.claimNext({ now: later(5), staleBefore: now, activatedAt: later(-100) })).toBeNull();
  expect(await row(stale.id)).toMatchObject({ status: 'UNKNOWN', claimToken: null });
  expect(await repository.recordSent({ id: stale.id, claimToken: stale.claimToken, now: later(6), messageId: '<late@example.com>' })).toBe(false);
  await repository.enqueue(notice());
  const uncertain = (await claim(later(6)))!;
  expect(await repository.recordUnknown({ id: uncertain.id, claimToken: uncertain.claimToken, now: later(7), failureCode: 'SMTP_UNCERTAIN' })).toBe(true);
  expect(await repository.claimNext({
    now: later(10), staleBefore: later(9), activatedAt: later(-100)
  })).toBeNull();
});

it('quarantines all stale sends exactly once during maintenance without claiming due work', async () => {
  const sends = await client.db.insert(lifecycleEmailOutbox).values([1, 2, 3].map((second) => ({
    ...notice({ recipient: 'admin@example.com' }), status: 'SENDING' as const,
    lastAttemptedAt: later(second), attempts: 1, claimToken: randomUUID(),
    cancellationRequestedAt: second === 2 ? later(3) : null
  }))).returning();
  const [pending] = await client.db.insert(lifecycleEmailOutbox)
    .values(notice({ recipient: 'admin@example.com' })).returning();
  const maintenance = { now: later(5), staleBefore: later(2) };
  expect(await repository.quarantineStaleSending(maintenance)).toBe(2);
  expect(await repository.quarantineStaleSending({ ...maintenance, now: later(6) })).toBe(0);
  for (const send of sends.slice(0, 2)) {
    expect(await row(send.id)).toEqual({
      ...send, status: 'UNKNOWN', claimToken: null, lastFailureCode: 'STALE_SENDING', updatedAt: later(5)
    });
  }
  expect(await row(sends[2]!.id)).toEqual(sends[2]);
  expect(await row(pending!.id)).toEqual(pending);
});

it('rejects stale-send maintenance cutoffs that are equal to or after the maintenance time', async () => {
  for (const staleBefore of [now, later(1)]) {
    await expect(repository.quarantineStaleSending({ now, staleBefore }))
      .rejects.toThrow('LIFECYCLE_EMAIL_INVALID_STALE_CUTOFF');
  }
});

it('cancels only unsent failures for the exact tenant and source, preserving immutable held evidence', async () => {
  const sourceId = randomUUID();
  const failure = notice({ sourceId, sourceType: 'BILLING_EPISODE', template: 'PAYMENT_FAILED' });
  await client.db.insert(billingCases).values({
    id: sourceId, organisationId, kind: 'PAYMENT_FAILURE', status: 'OPEN', providerObjectType: 'INVOICE',
    providerObjectId: sourceId, providerStatus: 'open', stripeSubscriptionId: sourceId,
    subscriptionRelation: 'CURRENT', amountMinor: 100, currency: 'aud', latestProviderEventId: sourceId,
    latestProviderEventCreatedAt: now, openedAt: now, recoveryEndsAt: later(100)
  });
  const [held] = await client.db.insert(transactionalEmailOutbox).values({
    organisationId, billingCaseId: sourceId, recipient: 'admin@example.com', template: 'PAYMENT_FAILED',
    renderData: {}, idempotencyKey: failure.idempotencyKey
  }).returning();
  await repository.enqueue(failure);
  const sending = (await claim())!;
  for (const overrides of [
    {}, { organisationId: await tenant() }, { sourceType: 'OTHER' }, { sourceId: randomUUID() }, { template: 'PAYMENT_RECOVERED' as const }
  ]) await repository.enqueue({ ...failure, idempotencyKey: randomUUID(), ...overrides });
  expect(await repository.cancelUnsentForSource({ organisationId, sourceType: 'BILLING_EPISODE', sourceId, template: 'PAYMENT_FAILED', now })).toBe(2);
  expect(await row(sending.id)).toMatchObject({ status: 'SENDING' });
  expect(await client.db.query.transactionalEmailOutbox.findFirst({ where: eq(transactionalEmailOutbox.id, held!.id) })).toEqual(held);
});
