import { describe, expect, it } from 'vitest';

import {
  decideSmsAllowance,
  summariseSmsUsage
} from './sms-commerce.js';

describe('Solo SMS allowance', () => {
  it('includes 2,000 parts and warns once projected use reaches 80 percent', () => {
    const legacyOverageSettings = {
      overageEnabled: true,
      overageCapCents: 10_000,
      overageCentsPerPart: 10
    };

    expect(
      decideSmsAllowance({
        committedParts: 1_590,
        reservedParts: 5,
        requestedParts: 5,
        includedParts: 2_000,
        warningPercent: 80,
        ...legacyOverageSettings
      })
    ).toEqual({
      kind: 'allowed',
      projectedParts: 1_600,
      warningThresholdReached: true
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
      warningThresholdReached: true
    });
  });

  it('blocks a multipart send that crosses the allowance despite legacy overage settings', () => {
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
      reason: 'SMS_ALLOWANCE_EXHAUSTED',
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
      warningThresholdReached: true
    });
  });

  it('blocks a retry whose legacy reservation is already over the allowance', () => {
    const input = {
      committedParts: 1_999,
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
      kind: 'blocked',
      reason: 'SMS_ALLOWANCE_EXHAUSTED',
      projectedParts: 2_001
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
