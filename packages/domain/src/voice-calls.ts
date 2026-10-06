import { Decimal } from 'decimal.js';
import { DateTime } from 'luxon';

import { createBusinessCalendar } from './calendar.js';
import type { InvoiceStatus, InvoiceType } from './invoices.js';

export type VoiceInvoiceExclusionReason =
  | 'DUPLICATE_INVOICE'
  | 'NOT_ACCREC'
  | 'NOT_AUTHORISED'
  | 'NO_BALANCE'
  | 'NOT_OVERDUE'
  | 'CONTACT_INACTIVE'
  | 'INVOICE_INACTIVE'
  | 'INVOICE_PAUSED'
  | 'CUSTOMER_PAUSED'
  | 'SEQUENCE_PAUSED'
  | 'WHITELISTED'
  | 'DISPUTED'
  | 'PROMISE_TO_PAY_ACTIVE'
  | 'NO_ACTIVE_CHASE'
  | 'CURRENCY_MISMATCH';

export interface VoiceDraftInvoiceInput {
  id: string;
  xeroInvoiceId: string;
  invoiceNumber: string;
  type: InvoiceType;
  status: InvoiceStatus;
  amountDue: string;
  currency: string;
  dueDate: string;
  contactActive: boolean;
  invoiceActive: boolean;
  invoicePaused: boolean;
  customerPaused: boolean;
  sequencePaused: boolean;
  whitelisted: boolean;
  disputed: boolean;
  promiseToPayActive: boolean;
  activeChase: boolean;
}

export interface VoiceDraftInput {
  currentLocalDate: string;
  organisationCurrency: string;
  invoices: readonly VoiceDraftInvoiceInput[];
}

export type VoiceDraftIncludedInvoice = VoiceDraftInvoiceInput;

export interface VoiceDraftExcludedInvoice {
  id: string;
  invoiceNumber: string;
  reasons: VoiceInvoiceExclusionReason[];
}

export interface VoiceDraftResult {
  includedInvoices: VoiceDraftIncludedInvoice[];
  excludedInvoices: VoiceDraftExcludedInvoice[];
  combinedAmount: string;
  currency: string;
}

const voiceInvoiceExclusionReasons = (
  invoice: VoiceDraftInvoiceInput,
  input: VoiceDraftInput
): VoiceInvoiceExclusionReason[] => {
  const reasons: VoiceInvoiceExclusionReason[] = [];

  if (invoice.type !== 'ACCREC') reasons.push('NOT_ACCREC');
  if (invoice.status !== 'AUTHORISED') reasons.push('NOT_AUTHORISED');
  if (new Decimal(invoice.amountDue).lte(0)) reasons.push('NO_BALANCE');
  if (invoice.dueDate >= input.currentLocalDate) reasons.push('NOT_OVERDUE');
  if (!invoice.contactActive) reasons.push('CONTACT_INACTIVE');
  if (!invoice.invoiceActive) reasons.push('INVOICE_INACTIVE');
  if (invoice.invoicePaused) reasons.push('INVOICE_PAUSED');
  if (invoice.customerPaused) reasons.push('CUSTOMER_PAUSED');
  if (invoice.sequencePaused) reasons.push('SEQUENCE_PAUSED');
  if (invoice.whitelisted) reasons.push('WHITELISTED');
  if (invoice.disputed) reasons.push('DISPUTED');
  if (invoice.promiseToPayActive) reasons.push('PROMISE_TO_PAY_ACTIVE');
  if (!invoice.activeChase) reasons.push('NO_ACTIVE_CHASE');
  if (invoice.currency !== input.organisationCurrency) {
    reasons.push('CURRENCY_MISMATCH');
  }

  return reasons;
};

const compareVoiceInvoices = (
  left: VoiceDraftInvoiceInput,
  right: VoiceDraftInvoiceInput
): number =>
  left.dueDate.localeCompare(right.dueDate) ||
  left.invoiceNumber.localeCompare(right.invoiceNumber);

export function buildCombinedVoiceDraft(
  input: VoiceDraftInput
): VoiceDraftResult {
  const includedInvoices: VoiceDraftIncludedInvoice[] = [];
  const excludedInvoices: VoiceDraftExcludedInvoice[] = [];
  const seenInvoiceIds = new Set<string>();

  for (const invoice of input.invoices) {
    if (seenInvoiceIds.has(invoice.id)) {
      excludedInvoices.push({
        id: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        reasons: ['DUPLICATE_INVOICE']
      });
      continue;
    }
    seenInvoiceIds.add(invoice.id);

    const reasons = voiceInvoiceExclusionReasons(invoice, input);
    if (reasons.length > 0) {
      excludedInvoices.push({
        id: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        reasons
      });
      continue;
    }

    includedInvoices.push(invoice);
  }

  includedInvoices.sort(compareVoiceInvoices);

  const combinedAmount = includedInvoices
    .reduce(
      (total, invoice) => total.plus(invoice.amountDue),
      new Decimal(0)
    )
    .toFixed(2);

  return {
    includedInvoices,
    excludedInvoices,
    combinedAmount,
    currency: input.organisationCurrency
  };
}

export interface VoiceScriptInvoiceInput {
  invoiceNumber: string;
  amountDue: string;
}

export interface VoiceScriptInput {
  businessName: string;
  customerName: string;
  callbackNumber: string;
  combinedAmount: string;
  currency: string;
  invoices: readonly VoiceScriptInvoiceInput[];
  explanatoryWording: string;
}

export interface VoiceScriptProtectedFacts {
  businessName: string;
  customerName: string;
  callbackNumber: string;
  combinedAmount: string;
  currency: string;
  invoiceLines: string[];
}

export interface VoiceCallScript {
  identityPrompt: string;
  explanatoryWording: string;
  accountReminder: string;
  transferWording: string;
  voicemail: string;
  protectedFacts: VoiceScriptProtectedFacts;
  editableFields: ['explanatoryWording'];
}

export function renderVoiceCallScript(
  input: VoiceScriptInput
): VoiceCallScript {
  const invoiceLines = [...input.invoices]
    .sort((left, right) =>
      left.invoiceNumber.localeCompare(right.invoiceNumber)
    )
    .map(
      (invoice) =>
        'Invoice ' +
        invoice.invoiceNumber +
        ': ' +
        input.currency +
        ' ' +
        new Decimal(invoice.amountDue).toFixed(2)
    );

  const identityPrompt =
    'Hello. This is a private accounts call from ' +
    input.businessName +
    ' for ' +
    input.customerName +
    '. If you are this person or authorised to manage this account, press 1. ' +
    'If we have reached the wrong person, press 2 or say that this is the wrong number.';

  const accountReminder =
    input.explanatoryWording +
    ' The combined amount is ' +
    input.currency +
    ' ' +
    new Decimal(input.combinedAmount).toFixed(2) +
    '. ' +
    invoiceLines.join('. ') +
    '.';

  const transferWording =
    'To speak with our accounts team now, press 1. Otherwise, you may contact ' +
    input.businessName +
    ' during business hours.';

  const voicemail =
    'This is ' +
    input.businessName +
    ' calling about your account. Please call our office on ' +
    input.callbackNumber +
    ' during business hours.';

  return {
    identityPrompt,
    explanatoryWording: input.explanatoryWording,
    accountReminder,
    transferWording,
    voicemail,
    protectedFacts: {
      businessName: input.businessName,
      customerName: input.customerName,
      callbackNumber: input.callbackNumber,
      combinedAmount: new Decimal(input.combinedAmount).toFixed(2),
      currency: input.currency,
      invoiceLines
    },
    editableFields: ['explanatoryWording']
  };
}

export type VoicePolicyBlockCode =
  | 'FEATURE_DISABLED'
  | 'PERMISSION_DENIED'
  | 'INVALID_DESTINATION'
  | 'VOICE_SUPPRESSED'
  | 'DISPUTE_OPEN'
  | 'PROMISE_ACTIVE'
  | 'PAUSED'
  | 'WHITELISTED'
  | 'STALE_ACCOUNT_DATA'
  | 'NO_ELIGIBLE_INVOICES'
  | 'ORGANISATION_CALL_IN_FLIGHT'
  | 'WEEKLY_FREQUENCY_LIMIT'
  | 'MONTHLY_FREQUENCY_LIMIT'
  | 'CALLING_WINDOW_CLOSED';

export interface VoiceAttemptInput {
  providerAcceptedAt: Date | null;
}

export interface VoiceContactPolicyInput {
  now: Date;
  timezone: string;
  holidays: string[];
  weekdayStartLocal: string;
  weekdayEndLocal: string;
  featureEnabled: boolean;
  permissionAllowed: boolean;
  destinationValid: boolean;
  voiceSuppressed: boolean;
  disputeOpen: boolean;
  promiseToPayActive: boolean;
  paused: boolean;
  whitelisted: boolean;
  staleAccountData: boolean;
  organisationCallInFlight: boolean;
  attempts: readonly VoiceAttemptInput[];
  includedInvoiceIds: readonly string[];
  excludedInvoices: readonly VoiceDraftExcludedInvoice[];
}

export interface VoiceContactPolicyDecision {
  allowed: boolean;
  blockCode: VoicePolicyBlockCode | null;
  nextPermittedAt: Date | null;
  includedInvoiceIds: string[];
  excludedInvoices: VoiceDraftExcludedInvoice[];
}

const parseLocalTime = (
  value: string
): { hour: number; minute: number } => {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (match === null) throw new Error('Invalid local time: ' + value);
  return {
    hour: Number(match[1]),
    minute: Number(match[2])
  };
};

const localTimeOnDate = (
  local: DateTime,
  value: string
): DateTime => {
  const parsed = parseLocalTime(value);
  return local.set({
    hour: parsed.hour,
    minute: parsed.minute,
    second: 0,
    millisecond: 0
  });
};

const nextCallingWindow = (
  instant: DateTime,
  input: VoiceContactPolicyInput
): DateTime => {
  const calendar = createBusinessCalendar({
    zone: input.timezone,
    holidays: input.holidays
  });
  const local = instant.setZone(input.timezone);
  const localDate = local.toISODate() ?? '';

  if (calendar.isBusinessDate(localDate)) {
    const start = localTimeOnDate(local, input.weekdayStartLocal);
    const end = localTimeOnDate(local, input.weekdayEndLocal);
    if (local < start) return start;
    if (local < end) return local;
  }

  const nextDate = calendar.nextBusinessDate(localDate);
  const nextLocal = DateTime.fromISO(nextDate, { zone: input.timezone });
  return localTimeOnDate(nextLocal, input.weekdayStartLocal);
};

const blockedDecision = (
  input: VoiceContactPolicyInput,
  blockCode: VoicePolicyBlockCode,
  nextPermittedAt: Date | null = null
): VoiceContactPolicyDecision => ({
  allowed: false,
  blockCode,
  nextPermittedAt,
  includedInvoiceIds: [...input.includedInvoiceIds],
  excludedInvoices: [...input.excludedInvoices]
});

export function evaluateVoiceContactPolicy(
  input: VoiceContactPolicyInput
): VoiceContactPolicyDecision {
  const staticBlocks: Array<[boolean, VoicePolicyBlockCode]> = [
    [!input.featureEnabled, 'FEATURE_DISABLED'],
    [!input.permissionAllowed, 'PERMISSION_DENIED'],
    [!input.destinationValid, 'INVALID_DESTINATION'],
    [input.voiceSuppressed, 'VOICE_SUPPRESSED'],
    [input.disputeOpen, 'DISPUTE_OPEN'],
    [input.promiseToPayActive, 'PROMISE_ACTIVE'],
    [input.paused, 'PAUSED'],
    [input.whitelisted, 'WHITELISTED'],
    [input.staleAccountData, 'STALE_ACCOUNT_DATA'],
    [input.includedInvoiceIds.length === 0, 'NO_ELIGIBLE_INVOICES'],
    [input.organisationCallInFlight, 'ORGANISATION_CALL_IN_FLIGHT']
  ];

  for (const [blocked, code] of staticBlocks) {
    if (blocked) return blockedDecision(input, code);
  }

  const now = DateTime.fromJSDate(input.now, { zone: input.timezone });
  const acceptedAttempts = input.attempts
    .map((attempt) => attempt.providerAcceptedAt)
    .filter((acceptedAt): acceptedAt is Date => acceptedAt !== null)
    .map((acceptedAt) =>
      DateTime.fromJSDate(acceptedAt, { zone: input.timezone })
    )
    .filter((acceptedAt) => acceptedAt <= now);

  const monthAttempts = acceptedAttempts.filter(
    (acceptedAt) =>
      acceptedAt.year === now.year && acceptedAt.month === now.month
  );
  if (monthAttempts.length >= 10) {
    const reset = now.startOf('month').plus({ months: 1 });
    return blockedDecision(
      input,
      'MONTHLY_FREQUENCY_LIMIT',
      nextCallingWindow(reset, input).toJSDate()
    );
  }

  const rollingCutoff = now.minus({ hours: 7 * 24 });
  const rollingAttempts = acceptedAttempts
    .filter((acceptedAt) => acceptedAt > rollingCutoff)
    .sort((left, right) => left.toMillis() - right.toMillis());
  if (rollingAttempts.length >= 3) {
    const reset = rollingAttempts[0]?.plus({ hours: 7 * 24 }) ?? now;
    return blockedDecision(
      input,
      'WEEKLY_FREQUENCY_LIMIT',
      nextCallingWindow(reset, input).toJSDate()
    );
  }

  const permittedAt = nextCallingWindow(now, input);
  if (permittedAt.toMillis() !== now.toMillis()) {
    return blockedDecision(
      input,
      'CALLING_WINDOW_CLOSED',
      permittedAt.toJSDate()
    );
  }

  return {
    allowed: true,
    blockCode: null,
    nextPermittedAt: null,
    includedInvoiceIds: [...input.includedInvoiceIds],
    excludedInvoices: [...input.excludedInvoices]
  };
}

export type VoiceCallOperationalState =
  | 'DRAFT'
  | 'PREVIEWED'
  | 'APPROVED'
  | 'QUEUED'
  | 'SUBMITTING'
  | 'ACCEPTED'
  | 'IN_PROGRESS'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'FAILED'
  | 'UNKNOWN';

export type VoiceCallOutcome =
  | 'IDENTITY_CONFIRMED'
  | 'IDENTITY_NOT_CONFIRMED'
  | 'REMINDER_DELIVERED'
  | 'VOICEMAIL_LEFT'
  | 'WRONG_PERSON'
  | 'TRANSFER_REQUESTED'
  | 'TRANSFERRED'
  | 'TRANSFER_UNANSWERED'
  | 'NO_ANSWER'
  | 'BUSY'
  | 'INVALID_DESTINATION'
  | 'PROVIDER_REJECTED';

export interface VoiceCallState {
  state: VoiceCallOperationalState;
  outcome: VoiceCallOutcome | null;
}

export type VoiceCallEvent =
  | 'PREVIEW_RECORDED'
  | 'APPROVED'
  | 'QUEUED'
  | 'SUBMISSION_STARTED'
  | 'PROVIDER_ACCEPTED'
  | 'CALL_STARTED'
  | 'IDENTITY_CONFIRMED'
  | 'IDENTITY_NOT_CONFIRMED'
  | 'REMINDER_DELIVERED'
  | 'VOICEMAIL_LEFT'
  | 'WRONG_PERSON'
  | 'TRANSFER_REQUESTED'
  | 'TRANSFERRED'
  | 'TRANSFER_UNANSWERED'
  | 'NO_ANSWER'
  | 'BUSY'
  | 'INVALID_DESTINATION'
  | 'PROVIDER_REJECTED'
  | 'CALL_ENDED'
  | 'CANCELLED'
  | 'PROVIDER_FAILED'
  | 'DISPATCH_UNKNOWN'
  | 'RECONCILED_COMPLETED'
  | 'RECONCILED_FAILED';

export type VoiceCallIgnoredReason =
  | 'DUPLICATE_EVENT'
  | 'TERMINAL_STATE'
  | 'UNKNOWN_REQUIRES_RECONCILIATION'
  | 'INVALID_TRANSITION';

export interface VoiceCallTransition extends VoiceCallState {
  changed: boolean;
  ignoredReason: VoiceCallIgnoredReason | null;
}

interface VoiceTransitionDefinition {
  state: VoiceCallOperationalState;
  outcome?: VoiceCallOutcome;
}

type VoiceTransitionTable = Partial<
  Record<
    VoiceCallOperationalState,
    Partial<Record<VoiceCallEvent, VoiceTransitionDefinition>>
  >
>;

const voiceTransitions: VoiceTransitionTable = {
  DRAFT: {
    PREVIEW_RECORDED: { state: 'PREVIEWED' },
    CANCELLED: { state: 'CANCELLED' }
  },
  PREVIEWED: {
    PREVIEW_RECORDED: { state: 'PREVIEWED' },
    APPROVED: { state: 'APPROVED' },
    CANCELLED: { state: 'CANCELLED' }
  },
  APPROVED: {
    QUEUED: { state: 'QUEUED' },
    CANCELLED: { state: 'CANCELLED' }
  },
  QUEUED: {
    SUBMISSION_STARTED: { state: 'SUBMITTING' },
    CANCELLED: { state: 'CANCELLED' }
  },
  SUBMITTING: {
    PROVIDER_ACCEPTED: { state: 'ACCEPTED' },
    PROVIDER_FAILED: {
      state: 'FAILED',
      outcome: 'PROVIDER_REJECTED'
    },
    DISPATCH_UNKNOWN: { state: 'UNKNOWN' }
  },
  ACCEPTED: {
    CALL_STARTED: { state: 'IN_PROGRESS' },
    VOICEMAIL_LEFT: {
      state: 'COMPLETED',
      outcome: 'VOICEMAIL_LEFT'
    },
    NO_ANSWER: { state: 'COMPLETED', outcome: 'NO_ANSWER' },
    BUSY: { state: 'COMPLETED', outcome: 'BUSY' },
    INVALID_DESTINATION: {
      state: 'FAILED',
      outcome: 'INVALID_DESTINATION'
    },
    PROVIDER_REJECTED: {
      state: 'FAILED',
      outcome: 'PROVIDER_REJECTED'
    }
  },
  IN_PROGRESS: {
    IDENTITY_CONFIRMED: {
      state: 'IN_PROGRESS',
      outcome: 'IDENTITY_CONFIRMED'
    },
    IDENTITY_NOT_CONFIRMED: {
      state: 'COMPLETED',
      outcome: 'IDENTITY_NOT_CONFIRMED'
    },
    REMINDER_DELIVERED: {
      state: 'IN_PROGRESS',
      outcome: 'REMINDER_DELIVERED'
    },
    VOICEMAIL_LEFT: {
      state: 'COMPLETED',
      outcome: 'VOICEMAIL_LEFT'
    },
    WRONG_PERSON: { state: 'COMPLETED', outcome: 'WRONG_PERSON' },
    TRANSFER_REQUESTED: {
      state: 'IN_PROGRESS',
      outcome: 'TRANSFER_REQUESTED'
    },
    TRANSFERRED: { state: 'COMPLETED', outcome: 'TRANSFERRED' },
    TRANSFER_UNANSWERED: {
      state: 'COMPLETED',
      outcome: 'TRANSFER_UNANSWERED'
    },
    CALL_ENDED: { state: 'COMPLETED' }
  },
  UNKNOWN: {
    RECONCILED_COMPLETED: { state: 'COMPLETED' },
    RECONCILED_FAILED: { state: 'FAILED' }
  }
};

const terminalVoiceStates = new Set<VoiceCallOperationalState>([
  'COMPLETED',
  'CANCELLED',
  'FAILED'
]);

const unchangedVoiceTransition = (
  current: VoiceCallState,
  ignoredReason: VoiceCallIgnoredReason
): VoiceCallTransition => ({
  ...current,
  changed: false,
  ignoredReason
});

export function transitionVoiceCallState(
  current: VoiceCallState,
  event: VoiceCallEvent
): VoiceCallTransition {
  if (terminalVoiceStates.has(current.state)) {
    return unchangedVoiceTransition(current, 'TERMINAL_STATE');
  }

  if (
    current.state === 'UNKNOWN' &&
    event !== 'RECONCILED_COMPLETED' &&
    event !== 'RECONCILED_FAILED'
  ) {
    return unchangedVoiceTransition(
      current,
      'UNKNOWN_REQUIRES_RECONCILIATION'
    );
  }

  const definition = voiceTransitions[current.state]?.[event];
  if (definition === undefined) {
    return unchangedVoiceTransition(current, 'INVALID_TRANSITION');
  }

  const outcome = definition.outcome ?? current.outcome;
  if (definition.state === current.state && outcome === current.outcome) {
    return unchangedVoiceTransition(current, 'DUPLICATE_EVENT');
  }

  return {
    state: definition.state,
    outcome,
    changed: true,
    ignoredReason: null
  };
}
