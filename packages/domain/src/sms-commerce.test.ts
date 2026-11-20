import { describe, expect, it } from 'vitest';

import {
  decideSmsAllowance,
  soloIncludedSmsParts,
  soloSmsOverageCentsPerPart,
  summariseSmsUsage
} from './sms-commerce.js';

describe('Solo SMS allowance', () => {
  it('includes 1,000 parts and warns once projected use reaches 80 percent', () => {
    const legacyOverageSettings = {
      overageEnabled: true,
      overageCapCents: 10_000,
      overageCentsPerPart: 10
    };

    expect(soloIncludedSmsParts).toBe(1_000);

    expect(
      decideSmsAllowance({
        committedParts: 790,
        reservedParts: 5,
        requestedParts: 5,
        includedParts: soloIncludedSmsParts,
        warningPercent: 80,
        ...legacyOverageSettings
      })
    ).toEqual({
      kind: 'allowed',
      projectedParts: 800,
      projectedOverageParts: 0,
      projectedOverageCents: 0,
      warningThresholdReached: true
    });
  });

  it('allows exactly 1,000 included parts and blocks overage when billing is disabled', () => {
    expect(
      decideSmsAllowance({
        committedParts: 999,
        reservedParts: 0,
        requestedParts: 1,
        includedParts: soloIncludedSmsParts,
        warningPercent: 80
      })
    ).toMatchObject({ kind: 'allowed', projectedParts: 1_000 });

    expect(
      decideSmsAllowance({
        committedParts: 1_000,
        reservedParts: 0,
        requestedParts: 1,
        includedParts: soloIncludedSmsParts,
        warningPercent: 80,
        overageEnabled: false,
        overageCapCents: null,
        overageCentsPerPart: soloSmsOverageCentsPerPart
      })
    ).toEqual({
      kind: 'blocked',
      reason: 'SMS_ALLOWANCE_EXHAUSTED',
      projectedParts: 1_001
    });
  });

  it('allows paid overage at exactly 11 cents per additional SMS part', () => {
    expect(soloSmsOverageCentsPerPart).toBe(11);

    expect(
      decideSmsAllowance({
        committedParts: 999,
        reservedParts: 0,
        requestedParts: 3,
        includedParts: soloIncludedSmsParts,
        warningPercent: 80,
        overageEnabled: true,
        overageCapCents: null,
        overageCentsPerPart: soloSmsOverageCentsPerPart
      })
    ).toEqual({
      kind: 'allowed',
      projectedParts: 1_002,
      projectedOverageParts: 2,
      projectedOverageCents: 22,
      warningThresholdReached: true
    });
  });

  it('fails closed when enabled overage is not configured at the approved 11-cent rate', () => {
    expect(
      decideSmsAllowance({
        committedParts: 1_000,
        reservedParts: 0,
        requestedParts: 1,
        includedParts: soloIncludedSmsParts,
        warningPercent: 80,
        overageEnabled: true,
        overageCapCents: null,
        overageCentsPerPart: 10
      })
    ).toEqual({
      kind: 'blocked',
      reason: 'SMS_OVERAGE_BILLING_NOT_READY',
      projectedParts: 1_001
    });
  });

  it('honours an optional customer overage cap while null means no cap', () => {
    const base = {
      committedParts: 1_000,
      reservedParts: 0,
      requestedParts: 2,
      includedParts: soloIncludedSmsParts,
      warningPercent: 80,
      overageEnabled: true,
      overageCentsPerPart: soloSmsOverageCentsPerPart
    };

    expect(decideSmsAllowance({ ...base, overageCapCents: 21 })).toEqual({
      kind: 'blocked',
      reason: 'SMS_OVERAGE_CAP_REACHED',
      projectedParts: 1_002
    });
    expect(decideSmsAllowance({ ...base, overageCapCents: null })).toMatchObject({
      kind: 'allowed',
      projectedOverageParts: 2,
      projectedOverageCents: 22
    });
  });

  it('allows a multipart send that reaches the included allowance exactly', () => {
    expect(
      decideSmsAllowance({
        committedParts: 1_998,
        reservedParts: 0,
        requestedParts: 2,
        includedParts: 2_000,
        warningPercent: 80
      })
    ).toEqual({
      kind: 'allowed',
      projectedParts: 2_000,
      projectedOverageParts: 0,
      projectedOverageCents: 0,
      warningThresholdReached: true
    });
  });

  it('blocks a multipart send when its persisted overage rate is not the approved rate', () => {
    const input = {
      committedParts: 1_999,
      reservedParts: 0,
      requestedParts: 2,
      includedParts: 2_000,
      warningPercent: 80,
      overageEnabled: true,
      overageCapCents: 10_000,
      overageCentsPerPart: 1
    };

    expect(decideSmsAllowance(input)).toEqual({
      kind: 'blocked',
      reason: 'SMS_OVERAGE_BILLING_NOT_READY',
      projectedParts: 2_001
    });
  });

  it('revalidates an exact-boundary retry without double-counting its reservation', () => {
    const input = {
      committedParts: 1_998,
      reservedParts: 2,
      requestedParts: 2,
      requestedPartsAlreadyReserved: true,
      includedParts: 2_000,
      warningPercent: 80,
      overageEnabled: true,
      overageCapCents: 10_000,
      overageCentsPerPart: 1
    };

    expect(decideSmsAllowance(input)).toEqual({
      kind: 'allowed',
      projectedParts: 2_000,
      projectedOverageParts: 0,
      projectedOverageCents: 0,
      warningThresholdReached: true
    });
  });

  it('revalidates an overage retry without double-counting its reservation', () => {
    const input = {
      committedParts: 1_999,
      reservedParts: 2,
      requestedParts: 2,
      requestedPartsAlreadyReserved: true,
      includedParts: 2_000,
      warningPercent: 80,
      overageEnabled: true,
      overageCapCents: 10_000,
      overageCentsPerPart: soloSmsOverageCentsPerPart
    };

    expect(decideSmsAllowance(input)).toEqual({
      kind: 'allowed',
      projectedParts: 2_001,
      projectedOverageParts: 1,
      projectedOverageCents: 11,
      warningThresholdReached: true
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
