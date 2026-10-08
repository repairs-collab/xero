import { describe, expect, it } from 'vitest';

import {
  buildVoiceCallDetailVariables,
  buildCombinedVoiceDraft,
  evaluateVoiceContactPolicy,
  fixedVoiceCallCopy,
  transitionVoiceCallState,
  type VoiceDraftInvoiceInput,
  type VoiceContactPolicyInput,
  type VoiceCallEvent,
  type VoiceCallState
} from './voice-calls.js';

const baseInvoice: VoiceDraftInvoiceInput = {
  id: 'invoice-1',
  xeroInvoiceId: 'xero-invoice-1',
  invoiceNumber: 'INV-1001',
  type: 'ACCREC',
  status: 'AUTHORISED',
  amountDue: '120.50',
  currency: 'AUD',
  dueDate: '2026-09-01',
  contactActive: true,
  invoiceActive: true,
  invoicePaused: false,
  customerPaused: false,
  sequencePaused: false,
  whitelisted: false,
  disputed: false,
  promiseToPayActive: false,
  activeChase: true
};

describe('buildCombinedVoiceDraft', () => {
  it('includes every eligible invoice exactly once and totals Decimal amounts by currency', () => {
    const result = buildCombinedVoiceDraft({
      currentLocalDate: '2026-10-07',
      organisationCurrency: 'AUD',
      invoices: [
        {
          ...baseInvoice,
          id: 'invoice-2',
          xeroInvoiceId: 'xero-invoice-2',
          invoiceNumber: 'INV-1002',
          amountDue: '80.05',
          dueDate: '2026-09-15'
        },
        baseInvoice,
        baseInvoice
      ]
    });

    expect(result.includedInvoices.map((invoice) => invoice.id)).toEqual([
      'invoice-1',
      'invoice-2'
    ]);
    expect(result.combinedAmount).toBe('200.55');
    expect(result.currency).toBe('AUD');
    expect(result.excludedInvoices).toEqual([
      {
        id: 'invoice-1',
        invoiceNumber: 'INV-1001',
        reasons: ['DUPLICATE_INVOICE']
      }
    ]);
  });

  it('lists paid, future, disputed, promised, paused, whitelisted, and inactive-chase invoices with stable exclusion codes', () => {
    const cases: Array<{
      id: string;
      patch: Partial<VoiceDraftInvoiceInput>;
      reason: string;
    }> = [
      { id: 'paid', patch: { amountDue: '0.00' }, reason: 'NO_BALANCE' },
      {
        id: 'future',
        patch: { dueDate: '2026-10-07' },
        reason: 'NOT_OVERDUE'
      },
      { id: 'disputed', patch: { disputed: true }, reason: 'DISPUTED' },
      {
        id: 'promised',
        patch: { promiseToPayActive: true },
        reason: 'PROMISE_TO_PAY_ACTIVE'
      },
      {
        id: 'paused',
        patch: { invoicePaused: true },
        reason: 'INVOICE_PAUSED'
      },
      {
        id: 'whitelisted',
        patch: { whitelisted: true },
        reason: 'WHITELISTED'
      },
      {
        id: 'inactive-chase',
        patch: { activeChase: false },
        reason: 'NO_ACTIVE_CHASE'
      }
    ];

    const result = buildCombinedVoiceDraft({
      currentLocalDate: '2026-10-07',
      organisationCurrency: 'AUD',
      invoices: cases.map(({ id, patch }, index) => ({
        ...baseInvoice,
        ...patch,
        id,
        xeroInvoiceId: 'xero-' + id,
        invoiceNumber: 'INV-' + String(2000 + index)
      }))
    });

    expect(result.includedInvoices).toEqual([]);
    expect(result.combinedAmount).toBe('0.00');
    expect(
      result.excludedInvoices.map(({ id, reasons }) => [id, reasons])
    ).toEqual(cases.map(({ id, reason }) => [id, [reason]]));
  });
});

describe('fixed voice call flow', () => {
  it('uses the approved generic opening and voicemail without customer-specific wording', () => {
    expect(fixedVoiceCallCopy).toEqual({
      version: 1,
      opening:
        'Hello. This is an automated call from Mott Appliance Repairs. If you are the account holder or authorised to manage the account associated with this telephone number, press 1 to hear the account details. To speak with a representative, press 2. If this is the wrong number, please say "wrong number".',
      invoiceDetailPattern:
        'Invoice [invoice number], outstanding amount [currency and amount].',
      totalPattern:
        'The total outstanding amount is [currency and combined amount].',
      afterDetails:
        'To speak with a representative, press 2. Otherwise, you may contact Mott Appliance Repairs during business hours.',
      voicemail:
        'This is Mott Appliance Repairs calling. Please call our office on [office number] during business hours.'
    });
    expect(JSON.stringify(fixedVoiceCallCopy)).not.toMatch(
      /customerName|balance due|payment link|debt|overdue/i
    );
  });

  it('builds deterministic protected invoice variables without editable wording', () => {
    const input = {
      callbackNumber: '02 5550 1234',
      combinedAmount: '200.55',
      currency: 'AUD',
      invoices: [
        {
          invoiceNumber: 'INV-1002',
          amountDue: '80.05',
          dueDate: '2026-09-15'
        },
        {
          invoiceNumber: 'INV-1001',
          amountDue: '120.50',
          dueDate: '2026-09-01'
        }
      ]
    };
    const first = buildVoiceCallDetailVariables(input);
    const second = buildVoiceCallDetailVariables({
      ...input,
      invoices: [...input.invoices].reverse()
    });

    expect(first).toEqual({
      callbackNumber: '02 5550 1234',
      combinedAmount: '200.55',
      currency: 'AUD',
      invoices: [
        { invoiceNumber: 'INV-1001', amountDue: '120.50' },
        { invoiceNumber: 'INV-1002', amountDue: '80.05' }
      ]
    });
    expect(second).toEqual(first);
    expect(first).not.toHaveProperty('customerName');
    expect(first).not.toHaveProperty('explanatoryWording');
  });
});

const basePolicyInput: VoiceContactPolicyInput = {
  now: new Date('2026-10-07T00:00:00.000Z'),
  timezone: 'Australia/Sydney',
  holidays: [],
  weekdayStartLocal: '09:00',
  weekdayEndLocal: '17:00',
  featureEnabled: true,
  permissionAllowed: true,
  destinationValid: true,
  voiceSuppressed: false,
  disputeOpen: false,
  promiseToPayActive: false,
  paused: false,
  whitelisted: false,
  staleAccountData: false,
  organisationCallInFlight: false,
  attempts: [],
  includedInvoiceIds: ['invoice-1'],
  excludedInvoices: []
};

describe('evaluateVoiceContactPolicy', () => {
  it.each([
    ['09:00', '2026-10-06T22:00:00.000Z', true],
    ['16:59', '2026-10-07T05:59:00.000Z', true],
    ['17:00', '2026-10-07T06:00:00.000Z', false]
  ])(
    'applies the Sydney weekday boundary at %s',
    (_label, now, allowed) => {
      const result = evaluateVoiceContactPolicy({
        ...basePolicyInput,
        now: new Date(now)
      });

      expect(result.allowed).toBe(allowed);
      expect(result.blockCode).toBe(
        allowed ? null : 'CALLING_WINDOW_CLOSED'
      );
      if (!allowed) {
        expect(result.nextPermittedAt?.toISOString()).toBe(
          '2026-10-07T22:00:00.000Z'
        );
      }
    }
  );

  it('returns the next permitted instant across Sydney daylight saving and a public holiday', () => {
    const result = evaluateVoiceContactPolicy({
      ...basePolicyInput,
      now: new Date('2026-10-02T07:00:00.000Z'),
      holidays: ['2026-10-05']
    });

    expect(result).toMatchObject({
      allowed: false,
      blockCode: 'CALLING_WINDOW_CLOSED'
    });
    expect(result.nextPermittedAt?.toISOString()).toBe(
      '2026-10-05T22:00:00.000Z'
    );
  });

  it('blocks three provider-accepted attempts for rolling seven days until the oldest expires', () => {
    const result = evaluateVoiceContactPolicy({
      ...basePolicyInput,
      attempts: [
        { providerAcceptedAt: new Date('2026-09-30T00:30:00.000Z') },
        { providerAcceptedAt: new Date('2026-10-02T01:00:00.000Z') },
        { providerAcceptedAt: new Date('2026-10-05T01:00:00.000Z') }
      ]
    });

    expect(result).toMatchObject({
      allowed: false,
      blockCode: 'WEEKLY_FREQUENCY_LIMIT'
    });
    expect(result.nextPermittedAt?.toISOString()).toBe(
      '2026-10-07T00:30:00.000Z'
    );
  });

  it('blocks ten provider-accepted attempts for the local calendar month until its next business opening', () => {
    const attempts = Array.from({ length: 10 }, (_, index) => ({
      providerAcceptedAt: new Date(Date.UTC(2026, 9, 1, 0, index))
    }));

    const result = evaluateVoiceContactPolicy({
      ...basePolicyInput,
      attempts
    });

    expect(result).toMatchObject({
      allowed: false,
      blockCode: 'MONTHLY_FREQUENCY_LIMIT'
    });
    expect(result.nextPermittedAt?.toISOString()).toBe(
      '2026-11-01T22:00:00.000Z'
    );
  });

  it('does not count a pre-acceptance cancellation as an attempt', () => {
    const result = evaluateVoiceContactPolicy({
      ...basePolicyInput,
      attempts: [
        { providerAcceptedAt: new Date('2026-10-01T00:00:00.000Z') },
        { providerAcceptedAt: new Date('2026-10-02T00:00:00.000Z') },
        { providerAcceptedAt: null }
      ]
    });

    expect(result.allowed).toBe(true);
  });

  it.each([
    ['disabled feature', { featureEnabled: false }, 'FEATURE_DISABLED'],
    ['missing permission', { permissionAllowed: false }, 'PERMISSION_DENIED'],
    ['invalid number', { destinationValid: false }, 'INVALID_DESTINATION'],
    ['suppression', { voiceSuppressed: true }, 'VOICE_SUPPRESSED'],
    ['dispute', { disputeOpen: true }, 'DISPUTE_OPEN'],
    ['promise', { promiseToPayActive: true }, 'PROMISE_ACTIVE'],
    ['pause', { paused: true }, 'PAUSED'],
    ['whitelist', { whitelisted: true }, 'WHITELISTED'],
    ['stale data', { staleAccountData: true }, 'STALE_ACCOUNT_DATA'],
    [
      'in-flight call',
      { organisationCallInFlight: true },
      'ORGANISATION_CALL_IN_FLIGHT'
    ],
    ['no invoices', { includedInvoiceIds: [] }, 'NO_ELIGIBLE_INVOICES']
  ] as const)('blocks %s with a stable code', (_label, patch, blockCode) => {
    expect(
      evaluateVoiceContactPolicy({
        ...basePolicyInput,
        ...patch
      })
    ).toMatchObject({
      allowed: false,
      blockCode
    });
  });
});

describe('transitionVoiceCallState', () => {
  it('moves through every forward operational state and preserves the latest safe outcome', () => {
    const events: Array<{
      event: VoiceCallEvent;
      state: VoiceCallState['state'];
      outcome: VoiceCallState['outcome'];
    }> = [
      { event: 'APPROVED', state: 'APPROVED', outcome: null },
      { event: 'QUEUED', state: 'QUEUED', outcome: null },
      { event: 'SUBMISSION_STARTED', state: 'SUBMITTING', outcome: null },
      { event: 'PROVIDER_ACCEPTED', state: 'ACCEPTED', outcome: null },
      { event: 'CALL_STARTED', state: 'IN_PROGRESS', outcome: null },
      {
        event: 'IDENTITY_CONFIRMED',
        state: 'IN_PROGRESS',
        outcome: 'IDENTITY_CONFIRMED'
      },
      {
        event: 'REMINDER_DELIVERED',
        state: 'IN_PROGRESS',
        outcome: 'REMINDER_DELIVERED'
      },
      {
        event: 'CALL_ENDED',
        state: 'COMPLETED',
        outcome: 'REMINDER_DELIVERED'
      }
    ];
    let current: VoiceCallState = { state: 'DRAFT', outcome: null };

    for (const expected of events) {
      const transition = transitionVoiceCallState(current, expected.event);
      expect(transition).toMatchObject({
        state: expected.state,
        outcome: expected.outcome,
        changed: true,
        ignoredReason: null
      });
      current = {
        state: transition.state,
        outcome: transition.outcome
      };
    }
  });

  it.each([
    [
      { state: 'DRAFT', outcome: null },
      'CANCELLED',
      { state: 'CANCELLED', outcome: null }
    ],
    [
      { state: 'SUBMITTING', outcome: null },
      'PROVIDER_FAILED',
      { state: 'FAILED', outcome: 'PROVIDER_REJECTED' }
    ],
    [
      { state: 'SUBMITTING', outcome: null },
      'DISPATCH_UNKNOWN',
      { state: 'UNKNOWN', outcome: null }
    ],
    [
      { state: 'IN_PROGRESS', outcome: null },
      'WRONG_PERSON',
      { state: 'COMPLETED', outcome: 'WRONG_PERSON' }
    ],
    [
      { state: 'ACCEPTED', outcome: null },
      'VOICEMAIL_LEFT',
      { state: 'COMPLETED', outcome: 'VOICEMAIL_LEFT' }
    ],
    [
      { state: 'IN_PROGRESS', outcome: 'TRANSFER_REQUESTED' },
      'TRANSFERRED',
      { state: 'COMPLETED', outcome: 'TRANSFERRED' }
    ]
  ] as const)(
    'maps %j plus %s to the expected terminal state',
    (current, event, expected) => {
      expect(
        transitionVoiceCallState(
          current as VoiceCallState,
          event as VoiceCallEvent
        )
      ).toMatchObject({
        ...expected,
        changed: true,
        ignoredReason: null
      });
    }
  );

  it('treats a duplicate event as a no-op', () => {
    expect(
      transitionVoiceCallState(
        { state: 'APPROVED', outcome: null },
        'APPROVED'
      )
    ).toEqual({
      state: 'APPROVED',
      outcome: null,
      changed: false,
      ignoredReason: 'DUPLICATE_EVENT'
    });
  });

  it('does not regress a terminal state when a late event arrives', () => {
    expect(
      transitionVoiceCallState(
        { state: 'COMPLETED', outcome: 'VOICEMAIL_LEFT' },
        'CALL_STARTED'
      )
    ).toEqual({
      state: 'COMPLETED',
      outcome: 'VOICEMAIL_LEFT',
      changed: false,
      ignoredReason: 'TERMINAL_STATE'
    });
  });

  it('does not resubmit an unknown call', () => {
    expect(
      transitionVoiceCallState(
        { state: 'UNKNOWN', outcome: null },
        'SUBMISSION_STARTED'
      )
    ).toEqual({
      state: 'UNKNOWN',
      outcome: null,
      changed: false,
      ignoredReason: 'UNKNOWN_REQUIRES_RECONCILIATION'
    });
  });

  it('retains explicit wrong-person and voicemail outcomes', () => {
    expect(
      transitionVoiceCallState(
        { state: 'COMPLETED', outcome: 'WRONG_PERSON' },
        'CALL_ENDED'
      ).outcome
    ).toBe('WRONG_PERSON');
    expect(
      transitionVoiceCallState(
        { state: 'COMPLETED', outcome: 'VOICEMAIL_LEFT' },
        'CALL_ENDED'
      ).outcome
    ).toBe('VOICEMAIL_LEFT');
  });
});
