export const soloIncludedSmsParts = 2_000;

export type SmsAllowanceBlocker =
  | 'SMS_ALLOWANCE_EXHAUSTED'
  | 'SMS_OVERAGE_CAP_REACHED';

export type SmsUsageEntryType = 'RESERVE' | 'COMMIT' | 'RELEASE' | 'ADJUST';

export interface SmsUsageEntry {
  entryType: SmsUsageEntryType;
  partDelta: number;
}

export interface SmsUsageSummary {
  committedParts: number;
  reservedParts: number;
}

export const summariseSmsUsage = (
  entries: readonly SmsUsageEntry[]
): SmsUsageSummary => {
  let committedParts = 0;
  let reservedParts = 0;
  for (const entry of entries) {
    if (!Number.isInteger(entry.partDelta)) {
      throw new Error('SMS_USAGE_PARTS_MUST_BE_INTEGER');
    }
    if (entry.entryType === 'RESERVE') reservedParts += entry.partDelta;
    else if (entry.entryType === 'COMMIT') {
      committedParts += entry.partDelta;
      reservedParts -= entry.partDelta;
    } else if (entry.entryType === 'RELEASE') {
      reservedParts += entry.partDelta;
    } else committedParts += entry.partDelta;
  }
  if (committedParts < 0 || reservedParts < 0) {
    throw new Error('SMS_USAGE_LEDGER_UNBALANCED');
  }
  return { committedParts, reservedParts };
};

export type SmsAllowanceDecision =
  | {
      kind: 'allowed';
      projectedParts: number;
      projectedOverageParts: number;
      projectedOverageCents: number;
      warningThresholdReached: boolean;
    }
  | {
      kind: 'blocked';
      reason: SmsAllowanceBlocker;
      projectedParts: number;
    };

export const decideSmsAllowance = (input: {
  committedParts: number;
  reservedParts: number;
  requestedParts: number;
  includedParts: number;
  warningPercent: number;
  overageEnabled: boolean;
  overageCapCents: number | null;
  overageCentsPerPart: number | null;
}): SmsAllowanceDecision => {
  const integerFields = [
    input.committedParts,
    input.reservedParts,
    input.requestedParts,
    input.includedParts,
    input.warningPercent
  ];
  if (
    integerFields.some((value) => !Number.isInteger(value)) ||
    input.committedParts < 0 ||
    input.reservedParts < 0 ||
    input.requestedParts < 1 ||
    input.includedParts < 1 ||
    input.warningPercent < 1 ||
    input.warningPercent > 100
  ) {
    throw new Error('SMS_ALLOWANCE_INPUT_INVALID');
  }

  const projectedParts =
    input.committedParts + input.reservedParts + input.requestedParts;
  const projectedOverageParts = Math.max(
    0,
    projectedParts - input.includedParts
  );
  if (projectedOverageParts > 0 && !input.overageEnabled) {
    return {
      kind: 'blocked',
      reason: 'SMS_ALLOWANCE_EXHAUSTED',
      projectedParts
    };
  }

  let projectedOverageCents = 0;
  if (projectedOverageParts > 0) {
    if (
      input.overageCapCents === null ||
      input.overageCentsPerPart === null ||
      !Number.isInteger(input.overageCapCents) ||
      !Number.isInteger(input.overageCentsPerPart) ||
      input.overageCapCents < 0 ||
      input.overageCentsPerPart < 1
    ) {
      return {
        kind: 'blocked',
        reason: 'SMS_OVERAGE_CAP_REACHED',
        projectedParts
      };
    }
    projectedOverageCents =
      projectedOverageParts * input.overageCentsPerPart;
    if (projectedOverageCents > input.overageCapCents) {
      return {
        kind: 'blocked',
        reason: 'SMS_OVERAGE_CAP_REACHED',
        projectedParts
      };
    }
  }

  return {
    kind: 'allowed',
    projectedParts,
    projectedOverageParts,
    projectedOverageCents,
    warningThresholdReached:
      projectedParts * 100 >= input.includedParts * input.warningPercent
  };
};
