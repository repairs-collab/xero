import { describe, expect, it } from 'vitest';

import { createManualReminderView } from '../src/app/(protected)/customers/[customerId]/manual-reminder-view.js';

describe('createManualReminderView', () => {
  it('provides an editable SMS with the Xero payment link and a telephone link', () => {
    const view = createManualReminderView({
      customerName: 'Customer',
      invoiceNumber: 'INV-200',
      amountDue: '100.0000',
      currency: 'AUD',
      dueDate: '2026-08-20',
      type: 'ACCREC',
      status: 'AUTHORISED',
      onlineInvoiceUrl: 'https://in.xero.test/INV-200',
      email: 'accounts@example.invalid',
      phone: '+61400000000',
      chasingPaused: false,
      customerActive: true,
      hasActiveChase: true,
      smsSuppressed: false,
      emailSuppressed: false,
      sendMode: 'live',
      recipientAllowlist: ['+61400000000', 'accounts@example.invalid']
    });

    expect(view.sms).toEqual({
      available: true,
      disabledReason: null,
      message:
        'Hi Customer, invoice INV-200 for AUD 100.00 was due 2026-08-20. Pay securely: https://in.xero.test/INV-200'
    });
    expect(view.email).toEqual({ available: true, disabledReason: null });
    expect(view.call).toEqual({ available: true, href: 'tel:+61400000000' });
  });

  it('explains why sending is unavailable while still allowing a phone call', () => {
    const view = createManualReminderView({
      customerName: 'Customer',
      invoiceNumber: 'INV-200',
      amountDue: '100.0000',
      currency: 'AUD',
      dueDate: '2026-08-20',
      type: 'ACCREC',
      status: 'AUTHORISED',
      onlineInvoiceUrl: null,
      email: null,
      phone: '+61400000000',
      chasingPaused: true,
      customerActive: true,
      hasActiveChase: true,
      smsSuppressed: false,
      emailSuppressed: false,
      sendMode: 'live',
      recipientAllowlist: ['+61400000000']
    });

    expect(view.sms).toMatchObject({
      available: false,
      disabledReason: 'Resume chasing before sending a reminder'
    });
    expect(view.email).toEqual({
      available: false,
      disabledReason: 'Resume chasing before sending a reminder'
    });
    expect(view.call).toEqual({ available: true, href: 'tel:+61400000000' });
  });

  it('disables suppressed and non-allowlisted destinations with specific reasons', () => {
    const base = {
      customerName: 'Customer',
      invoiceNumber: 'INV-200',
      amountDue: '100.0000',
      currency: 'AUD',
      dueDate: '2026-08-20',
      type: 'ACCREC',
      status: 'AUTHORISED',
      onlineInvoiceUrl: 'https://in.xero.test/INV-200',
      email: 'accounts@example.invalid',
      phone: '+61400000000',
      chasingPaused: false,
      customerActive: true,
      hasActiveChase: true,
      emailSuppressed: false,
      sendMode: 'live' as const
    };

    const suppressed = createManualReminderView({
      ...base,
      smsSuppressed: true,
      recipientAllowlist: ['+61400000000', 'accounts@example.invalid']
    });
    expect(suppressed.sms.disabledReason).toBe('Customer has opted out of SMS reminders');
    expect(suppressed.email.available).toBe(true);

    const notAllowlisted = createManualReminderView({
      ...base,
      smsSuppressed: false,
      recipientAllowlist: []
    });
    expect(notAllowlisted.sms.disabledReason).toBe('Mobile is not on the live-send allowlist');
    expect(notAllowlisted.email.disabledReason).toBe('Email is not on the live-send allowlist');
  });
});
