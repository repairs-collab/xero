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

  it('makes every public record category explicit without inventing legal periods', () => {
    expect(accountPulseRetentionMatrix.map((row) => row.category)).toEqual([
      'XERO_REFRESH_TOKEN',
      'OAUTH_TRANSIENT_TOKEN',
      'UNRESOLVED_RECEIVABLE',
      'OUTBOUND_MESSAGE_CONTENT',
      'INBOUND_MESSAGE_CONTENT',
      'PROCESSED_WEBHOOK_PAYLOAD',
      'AUDIT_METADATA',
      'BILLING_RECORD',
      'DATABASE_BACKUP'
    ]);
    expect(
      accountPulseRetentionMatrix.find(
        (row) => row.category === 'AUDIT_METADATA'
      )?.duration
    ).toBeNull();
    expect(
      accountPulseRetentionMatrix.find(
        (row) => row.category === 'BILLING_RECORD'
      )?.duration
    ).toBeNull();
    expect(
      accountPulseRetentionMatrix.find(
        (row) => row.category === 'DATABASE_BACKUP'
      )?.duration
    ).toBeNull();
  });
});
