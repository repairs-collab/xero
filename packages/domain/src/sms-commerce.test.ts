import { describe, expect, it } from 'vitest';

import {
  decideSmsAllowance,
  summariseSmsUsage
} from './sms-commerce.js';

describe('Solo SMS allowance', () => {
  it('includes 2,000 parts and warns once projected use reaches 80 percent', () => {
    expect(
      decideSmsAllowance({
        committedParts: 1_590,
        reservedParts: 5,
        requestedParts: 5,
        includedParts: 2_000,
        warningPercent: 80,
        overageEnabled: false,
        overageCapCents: null,
        overageCentsPerPart: null
      })
    ).toEqual({
      kind: 'allowed',
      projectedParts: 1_600,
      projectedOverageParts: 0,
      projectedOverageCents: 0,
      warningThresholdReached: true
    });
  });

  it('fails closed when the included allowance would be exceeded', () => {
    expect(
      decideSmsAllowance({
        committedParts: 1_999,
        reservedParts: 1,
        requestedParts: 1,
        includedParts: 2_000,
        warningPercent: 80,
        overageEnabled: false,
        overageCapCents: null,
        overageCentsPerPart: null
      })
    ).toEqual({
      kind: 'blocked',
      reason: 'SMS_ALLOWANCE_EXHAUSTED',
      projectedParts: 2_001
    });
  });

  it('requires a verified rate and stays within an explicit overage cap', () => {
    const base = {
      committedParts: 2_000,
      reservedParts: 0,
      requestedParts: 10,
      includedParts: 2_000,
      warningPercent: 80,
      overageEnabled: true,
      overageCapCents: 100
    };

    expect(
      decideSmsAllowance({ ...base, overageCentsPerPart: null })
    ).toEqual({
      kind: 'blocked',
      reason: 'SMS_OVERAGE_CAP_REACHED',
      projectedParts: 2_010
    });
    expect(
      decideSmsAllowance({ ...base, overageCentsPerPart: 8 })
    ).toEqual({
      kind: 'allowed',
      projectedParts: 2_010,
      projectedOverageParts: 10,
      projectedOverageCents: 80,
      warningThresholdReached: true
    });
    expect(
      decideSmsAllowance({ ...base, overageCentsPerPart: 11 })
    ).toEqual({
      kind: 'blocked',
      reason: 'SMS_OVERAGE_CAP_REACHED',
      projectedParts: 2_010
    });
  });

  it('summarises an append-only reserve, commit, release and adjustment ledger', () => {
    expect(
      summariseSmsUsage([
        { entryType: 'RESERVE', partDelta: 3 },
        { entryType: 'COMMIT', partDelta: 3 },
        { entryType: 'RESERVE', partDelta: 2 },
        { entryType: 'RELEASE', partDelta: -2 },
        { entryType: 'ADJUST', partDelta: -1 }
      ])
    ).toEqual({ committedParts: 2, reservedParts: 0 });
  });
});
