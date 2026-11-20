export const soloIncludedSmsParts = 1_000;
export const soloSmsOverageCentsPerPart = 11;

export type SmsAllowanceBlocker =
  | 'SMS_ALLOWANCE_EXHAUSTED'
  | 'SMS_OVERAGE_BILLING_NOT_READY'
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
  requestedPartsAlreadyReserved?: boolean;
  includedParts: number;
  warningPercent: number;
  overageEnabled?: boolean;
  overageCapCents?: number | null;
  overageCentsPerPart?: number | null;
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
    input.committedParts +
    input.reservedParts +
    (input.requestedPartsAlreadyReserved === true ? 0 : input.requestedParts);
  const projectedOverageParts = Math.max(
    0,
    projectedParts - input.includedParts
  );
  if (projectedOverageParts > 0 && input.overageEnabled !== true) {
    return {
      kind: 'blocked',
      reason: 'SMS_ALLOWANCE_EXHAUSTED',
      projectedParts
    };
  }
  if (
    projectedOverageParts > 0 &&
    input.overageCentsPerPart !== soloSmsOverageCentsPerPart
  ) {
    return {
      kind: 'blocked',
      reason: 'SMS_OVERAGE_BILLING_NOT_READY',
      projectedParts
    };
  }
  const projectedOverageCents =
    projectedOverageParts * soloSmsOverageCentsPerPart;
  if (
    projectedOverageParts > 0 &&
    input.overageCapCents !== null &&
    input.overageCapCents !== undefined &&
    (!Number.isInteger(input.overageCapCents) ||
      input.overageCapCents < 0 ||
      projectedOverageCents > input.overageCapCents)
  ) {
    return {
      kind: 'blocked',
      reason: 'SMS_OVERAGE_CAP_REACHED',
      projectedParts
    };
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
