import { describe, expect, it } from 'vitest';

import type { ApprovedVoiceFacts } from '../src/contracts.js';
import {
  formatAccountOpening,
  formatProtectedDetails,
  formatVoicemail
} from '../src/speech/formatter.js';

const facts: ApprovedVoiceFacts = {
  accountName: "O'Brien & Sons Pty Ltd",
  combinedAmount: '120.50',
  currency: 'AUD',
  invoices: [
    {
      invoiceNumber: 'INV-1001',
      amountDue: '120.50',
      dueDate: '2026-09-01'
    }
  ]
};

describe('deterministic voice formatting', () => {
  it('identifies the approved account before presenting keypad choices', () => {
    const opening = formatAccountOpening(facts.accountName);
    expect(opening).toEqual([
      {
        kind: 'ACCOUNT_OPENING',
        protected: false,
        text: "Hello. This is an automated call from Mott Appliance Repairs intended for the account of O'Brien and Sons Pty Ltd. If you are the account holder or authorised to manage this account, press 1 to hear the invoice details. To speak with a representative, press 2. If this is the wrong number, press 9."
      }
    ]);
    expect(opening[0]?.text).not.toMatch(/INV-1001|120\.50|overdue|balance|debt/i);
  });

  it('spells invoice identifiers and Australian currency predictably', () => {
    const segments = formatProtectedDetails(facts);
    expect(segments).toEqual([
      {
        kind: 'PROTECTED_DETAIL',
        protected: true,
        text: 'Invoice I N V dash one zero zero one. Amount one hundred and twenty Australian dollars and fifty cents.'
      },
      {
        kind: 'PROTECTED_SUMMARY',
        protected: true,
        text: 'The combined balance for these invoices is one hundred and twenty Australian dollars and fifty cents.'
      }
    ]);
  });

  it('handles zero, singular values, cents, punctuation, and multiple invoices', () => {
    expect(
      formatProtectedDetails({
        accountName: 'Sample Account',
        combinedAmount: '1.06',
        currency: 'AUD',
        invoices: [
          {
            invoiceNumber: 'A/0.1',
            amountDue: '0.05',
            dueDate: '2026-09-01'
          },
          {
            invoiceNumber: 'B_2#',
            amountDue: '1.01',
            dueDate: '2026-09-02'
          }
        ]
      }).map((segment) => segment.text)
    ).toEqual([
      'Invoice A slash zero dot one. Amount five cents.',
      'Invoice B underscore two number. Amount one Australian dollar and one cent.',
      'The combined balance for these invoices is one Australian dollar and six cents.'
    ]);
    expect(
      formatProtectedDetails({ ...facts, combinedAmount: '0.00', invoices: [{ ...facts.invoices[0]!, amountDue: '0.00' }] })[0]?.text
    ).toContain('zero Australian dollars');
  });

  it('accepts the maximum invoice count but rejects unsupported or oversized speech', () => {
    const maximum = Array.from({ length: 20 }, (_, index) => ({
      invoiceNumber: `I-${index + 1}`,
      amountDue: '1.00',
      dueDate: '2026-09-01'
    }));
    expect(
      formatProtectedDetails({
        accountName: 'Maximum Account',
        combinedAmount: '20.00',
        currency: 'AUD',
        invoices: maximum
      })
    ).toHaveLength(21);

    expect(() =>
      formatProtectedDetails({
        accountName: 'Too Many',
        combinedAmount: '21.00',
        currency: 'AUD',
        invoices: [...maximum, maximum[0]!]
      })
    ).toThrow('VOICE_INVOICE_LIMIT_EXCEEDED');
    expect(() =>
      formatProtectedDetails({
        ...facts,
        invoices: [{ ...facts.invoices[0]!, invoiceNumber: 'INV-🔥' }]
      })
    ).toThrow('VOICE_TEXT_UNSUPPORTED');
    expect(() =>
      formatProtectedDetails({
        accountName: 'Too Long',
        combinedAmount: '20.00',
        currency: 'AUD',
        invoices: maximum.map((invoice) => ({
          ...invoice,
          invoiceNumber: 'A'.repeat(100)
        }))
      })
    ).toThrow('VOICE_SPEECH_TOO_LONG');
  });

  it('rejects unsupported account characters and mismatched totals', () => {
    expect(() => formatAccountOpening('Account 🔥')).toThrow(
      'VOICE_TEXT_UNSUPPORTED'
    );
    expect(() =>
      formatProtectedDetails({ ...facts, combinedAmount: '120.51' })
    ).toThrow('VOICE_TOTAL_MISMATCH');
  });

  it('ignores unapproved fields and never invents collection claims', () => {
    const tainted = {
      ...facts,
      overdueClaim: 'seriously overdue',
      fee: '25.00',
      threat: 'legal action',
      negotiation: 'discount available'
    } as ApprovedVoiceFacts;
    const speech = formatProtectedDetails(tainted)
      .map((segment) => segment.text)
      .join(' ');
    expect(speech).not.toMatch(
      /overdue|fee|legal|threat|discount|negot|due date|consequence/i
    );
  });

  it('keeps voicemail generic and free of account or invoice facts', () => {
    const voicemail = formatVoicemail('03 5032 4518');
    expect(voicemail).toEqual([
      {
        kind: 'VOICEMAIL',
        protected: false,
        text: 'This is Mott Appliance Repairs calling. Please call our office on 03 5032 4518 during business hours.'
      }
    ]);
    expect(voicemail[0]?.text).not.toMatch(/O'Brien|INV|120|account/i);
  });
});
