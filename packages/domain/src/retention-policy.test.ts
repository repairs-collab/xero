import { describe, expect, it } from 'vitest';

import {
  accountRetentionTransition,
  accountPulseRetentionMatrix
} from './retention-policy.js';

describe('AccountPulse retention policy', () => {
  it('never turns a due account deadline into an automatic purge', () => {
    expect(
      accountRetentionTransition({
        currentStatus: 'SCHEDULED',
        deadline: new Date('2026-12-10T00:00:00.000Z'),
        now: new Date('2026-12-09T23:59:59.999Z')
      })
    ).toBe('SCHEDULED');

    expect(
      accountRetentionTransition({
        currentStatus: 'SCHEDULED',
        deadline: new Date('2026-12-10T00:00:00.000Z'),
        now: new Date('2026-12-10T00:00:00.000Z')
      })
    ).toBe('REVIEW_REQUIRED');
  });

  it('keeps a review or legal hold stable across retries', () => {
    expect(
      accountRetentionTransition({
        currentStatus: 'REVIEW_REQUIRED',
        deadline: new Date('2026-12-01T00:00:00.000Z'),
        now: new Date('2026-12-10T00:00:00.000Z')
      })
    ).toBe('REVIEW_REQUIRED');
    expect(
      accountRetentionTransition({
        currentStatus: 'LEGAL_HOLD',
        deadline: new Date('2026-12-01T00:00:00.000Z'),
        now: new Date('2026-12-10T00:00:00.000Z')
      })
    ).toBe('LEGAL_HOLD');
  });

  it('applies five years only to approved account records and keeps the direct-debit exception narrow', () => {
    expect(accountPulseRetentionMatrix.map((row) => row.category)).toEqual([
      'XERO_REFRESH_TOKEN',
      'OAUTH_TRANSIENT_TOKEN',
      'UNRESOLVED_RECEIVABLE',
      'OUTBOUND_MESSAGE_CONTENT',
      'INBOUND_MESSAGE_CONTENT',
      'PROCESSED_WEBHOOK_PAYLOAD',
      'CUSTOMER_RECORD',
      'INVOICE_RECORD',
      'MESSAGE_METADATA',
      'CALL_METADATA',
      'AUDIT_METADATA',
      'BILLING_RECORD',
      'DIRECT_DEBIT_MANDATE_EVIDENCE',
      'DATABASE_BACKUP'
    ]);
    const fiveYearCategories = [
      'CUSTOMER_RECORD',
      'INVOICE_RECORD',
      'MESSAGE_METADATA',
      'CALL_METADATA',
      'AUDIT_METADATA'
    ];
    expect(
      accountPulseRetentionMatrix
        .filter((row) => fiveYearCategories.includes(row.category))
        .map((row) => ({
          category: row.category,
          duration: row.duration,
          implementation: row.implementation
        }))
    ).toEqual(
      fiveYearCategories.map((category) => ({
        category,
        duration: '5 years after account cancellation',
        implementation: 'ENFORCED'
      }))
    );
    expect(
      accountPulseRetentionMatrix.find(
        (row) => row.category === 'BILLING_RECORD'
      )?.duration
    ).toBeNull();
    expect(
      accountPulseRetentionMatrix.find(
        (row) => row.category === 'DIRECT_DEBIT_MANDATE_EVIDENCE'
      )?.duration
    ).toBe('Up to 7 years where BECS or Stripe rules require it');
    expect(
      accountPulseRetentionMatrix.find(
        (row) => row.category === 'DATABASE_BACKUP'
      )?.duration
    ).toBeNull();
  });

  it('keeps the shorter raw-content and processed-webhook minimisation periods', () => {
    expect(
      accountPulseRetentionMatrix.find(
        (row) => row.category === 'OUTBOUND_MESSAGE_CONTENT'
      )?.duration
    ).toBe('24 months');
    expect(
      accountPulseRetentionMatrix.find(
        (row) => row.category === 'PROCESSED_WEBHOOK_PAYLOAD'
      )?.duration
    ).toBe('90 days');
  });
});
