import { randomUUID } from 'node:crypto';

import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AppSession } from '@bc5000/auth';
import { createDatabase, migrateDatabase, organisations, reminderSequences, reminderSequenceVersions, sequenceStages, users } from '@bc5000/db';

import { createSequenceService, type SequenceDraft } from '../src/app/(protected)/sequences/sequence-service.js';

const client = createDatabase(process.env.DATABASE_URL ?? 'postgres://bc5000:bc5000@localhost:5432/bc5000');
const now = new Date('2026-09-18T02:00:00.000Z');
beforeAll(async () => migrateDatabase(client.db));
afterAll(async () => client.pool.end());

async function seedSequence() {
  const organisationId = randomUUID();
  const sequenceId = randomUUID();
  const userId = randomUUID();
  await client.db.insert(organisations).values({ id: organisationId, xeroOrganisationId: randomUUID(), name: 'Sequence test', timeZone: 'Australia/Sydney', baseCurrency: 'AUD' });
  await client.db.insert(users).values({ id: userId, cognitoSubject: randomUUID(), email: `${userId}@example.invalid`, displayName: 'Admin' });
  await client.db.insert(reminderSequences).values({ id: sequenceId, organisationId, name: 'Standard', mode: 'REVIEW' });
  await client.db.insert(reminderSequenceVersions).values({ organisationId, sequenceId, versionNumber: 1, status: 'ACTIVE', activatedAt: new Date('2026-09-01T00:00:00Z') });
  const session = (role: 'ADMIN' | 'OPERATOR'): AppSession => ({ userId, cognitoSubject: randomUUID(), displayName: 'User', expiresAt: '2026-09-18T10:00:00Z', memberships: [{ organisationId, role, active: true }] });
  return { organisationId, sequenceId, session };
}

function draft(organisationId: string, sequenceId: string): SequenceDraft {
  return { organisationId, sequenceId, dailyBasis: 'BUSINESS_DAYS', smsAggregation: 'CONSOLIDATED_CUSTOMER', sendTime: '09:00', socialWindowStart: '08:00', socialWindowEnd: '18:00', minimumBalance: '0', maxSmsSegments: 3, xeroEmailAfterSmsOptOut: true, allowedCurrencies: ['AUD'], exclusions: [], stages: [
    { key: 'due-date', offsetDays: 0, channels: ['SMS'], template: 'Hi {{customer_name}}, invoice {{invoice_number}} is due today.' },
    { key: 'seven-days', offsetDays: 7, channels: ['XERO_EMAIL', 'SMS'], template: 'Invoice {{invoice_number}} is now 7 days overdue.' },
    { key: 'twenty-one-days', offsetDays: 21, channels: ['SMS'], template: 'Final reminder: {{invoice_number}} remains overdue.' },
    { key: 'thirty-days', offsetDays: 30, channels: ['TASK', 'SMS_DAILY'], template: 'Please contact us about {{invoice_number}}.' }
  ] };
}

describe('sequence administration', () => {
  it('allows only an Admin to activate automatic mode', async () => {
    const seeded = await seedSequence();
    const service = createSequenceService({ database: client.db, clock: { now: () => now } });
    await expect(service.setSequenceMode(seeded.session('OPERATOR'), { organisationId: seeded.organisationId, sequenceId: seeded.sequenceId, mode: 'AUTOMATIC' })).rejects.toThrow('FORBIDDEN');
  });

  it('creates an immutable active version and a 30-day preview', async () => {
    const seeded = await seedSequence();
    const service = createSequenceService({ database: client.db, clock: { now: () => now } });
    const result = await service.activateSequenceVersion(seeded.session('ADMIN'), draft(seeded.organisationId, seeded.sequenceId));
    expect(result.versionNumber).toBe(2);
    expect(result.preview.window).toEqual({ days: 30 });
    const versions = await client.db.select().from(reminderSequenceVersions).where(and(eq(reminderSequenceVersions.organisationId, seeded.organisationId), eq(reminderSequenceVersions.sequenceId, seeded.sequenceId)));
    expect(versions.map((row) => [row.versionNumber, row.status])).toEqual(expect.arrayContaining([[1, 'RETIRED'], [2, 'ACTIVE']]));
    const stages = await client.db.select().from(sequenceStages).where(eq(sequenceStages.sequenceVersionId, result.versionId));
    expect(stages).toHaveLength(6);
  });

  it.each([
    ['unknown token', (value: SequenceDraft) => { value.stages[0]!.template = 'Pay {{bank_password}}'; }],
    ['mixed currency consolidation', (value: SequenceDraft) => { value.allowedCurrencies = ['AUD', 'NZD']; }],
    ['empty sequence', (value: SequenceDraft) => { value.stages = []; }],
    ['duplicate offset and channel', (value: SequenceDraft) => { value.stages.push({ key: 'duplicate', offsetDays: 0, channels: ['SMS'], template: 'Duplicate' }); }],
    ['invalid social window', (value: SequenceDraft) => { value.socialWindowStart = '18:00'; value.socialWindowEnd = '08:00'; }]
  ])('rejects %s', async (_label, mutate) => {
    const seeded = await seedSequence();
    const value = draft(seeded.organisationId, seeded.sequenceId);
    mutate(value);
    const service = createSequenceService({ database: client.db, clock: { now: () => now } });
    await expect(service.activateSequenceVersion(seeded.session('ADMIN'), value)).rejects.toThrow();
  });
});
