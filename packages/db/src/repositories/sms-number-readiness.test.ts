import { describe, expect, it } from 'vitest';
import { getTableName } from 'drizzle-orm';
import { readFile } from 'node:fs/promises';
import type { Database } from '../connection.js';
import { PostgresSmsCommerceRepository } from './sms-commerce-repository.js';

describe('SMS number readiness billing cutoff', () => {
  it('locks the organisation before the subscription for trial updates', async () => {
    const source = await readFile(new URL('./platform-admin-repository.ts', import.meta.url), 'utf8');
    const start = source.indexOf('private async updateTrial(');
    const body = source.slice(start, source.indexOf('  extendTrial(', start));
    expect(body.indexOf('.from(organisations)')).toBeGreaterThan(-1);
    expect(body.indexOf('.from(organisations)')).toBeLessThan(body.indexOf('.from(subscriptions)'));
    expect(body.slice(body.indexOf('.from(organisations)'), body.indexOf('.from(subscriptions)'))).toContain(".for('update')");
  });
  it('orders platform-owned number mutations behind organisation and subscription locks', async () => {
    const source = await readFile(new URL('./platform-admin-repository.ts', import.meta.url), 'utf8');
    const lockHelper = source.slice(source.indexOf('const lockNumberOrganisation'), source.indexOf('export type PlatformOrganisationSort'));
    expect(lockHelper.indexOf('.from(organisations)')).toBeLessThan(lockHelper.indexOf('.from(subscriptions)'));
    for (const [start, end] of [['async assignSmsNumber(', 'async markSmsNumberReady('], ['async markSmsNumberReady(', 'private async placeNumberInQuarantine('], ['private async placeNumberInQuarantine(', 'quarantineSmsNumber('], ['async returnSmsNumberToPool(', 'async updateSmsAllowance(']] as const) {
      const startAt = source.indexOf(start);
      const body = source.slice(startAt, source.indexOf(end, startAt));
      expect(body.indexOf('lockNumberOrganisation(')).toBeGreaterThan(-1);
      expect(body.indexOf('lockNumberOrganisation(')).toBeLessThan(body.indexOf(".for('update')"));
    }
  });
  it.each(['reserve-existing', 'reserve-available', 'ready'] as const)('locks organisation then subscription then number and rechecks after contention for %s', async (operation) => {
    const boundary = new Date('2026-11-10T00:00:00Z');
    const before = new Date(boundary.getTime() - 1);
    let current = before;
    const locks: string[] = [];
    let numberReads = 0;
    let writes = 0;
    const transaction = {
      select: () => {
        let table = '';
        const chain = {
          from: (value: Parameters<typeof getTableName>[0]) => { table = getTableName(value); return chain; },
          where: () => chain,
          orderBy: () => chain,
          for: () => { locks.push(table); return chain; },
          limit: () => {
            if (table === 'organisations') return Promise.resolve([{ id: 'org' }]);
            if (table === 'subscriptions') return Promise.resolve([{ status: 'CANCEL_AT_PERIOD_END', stripeProviderStatus: 'active', currentPeriodEnd: boundary, cancelAt: null }]);
            if (operation === 'reserve-available' && ++numberReads === 1) return Promise.resolve([]);
            current = boundary;
            return Promise.resolve([{ id: 'number', e164Number: '+61400000009', status: 'RESERVED', provider: 'SINCH', providerNumberId: 'p', providerVerifiedAt: before }]);
          }
        };
        return chain;
      },
      update: () => { writes++; throw new Error('unexpected write'); }
    };
    const database = { transaction: (work: (tx: typeof transaction) => unknown) => work(transaction) } as unknown as Database;
    const repository = new PostgresSmsCommerceRepository(database, { now: () => current });
    const result = operation !== 'ready' ? repository.reserveAvailableNumber('org', before) : repository.markNumberReady('org', 'number', before);
    await expect(result).rejects.toThrow('PAID_SUBSCRIPTION_REQUIRED');
    expect(locks).toEqual(operation === 'reserve-available' ? ['organisations', 'subscriptions', 'sms_number_pool', 'sms_number_pool'] : ['organisations', 'subscriptions', 'sms_number_pool']);
    expect(writes).toBe(0);
  });
  it('rechecks the clock after locking when the caller time is stale', async () => {
    const boundary = new Date('2026-11-10T00:00:00Z');
    const chain = {
      from: () => chain, where: () => chain, for: () => chain,
      limit: () => Promise.resolve([{ status: 'CANCEL_AT_PERIOD_END', stripeProviderStatus: 'active', currentPeriodEnd: boundary, cancelAt: null }])
    };
    let selected = 0;
    const transaction = { select: () => { if (++selected > 2) throw new Error('unexpected number lookup'); return chain; } };
    const database = { transaction: (work: (tx: typeof transaction) => unknown) => work(transaction) } as unknown as Database;
    const repository = new PostgresSmsCommerceRepository(database, { now: () => boundary });
    await expect(repository.markNumberReady('org', 'number', new Date(boundary.getTime() - 1))).rejects.toThrow('PAID_SUBSCRIPTION_REQUIRED');
  });
});
