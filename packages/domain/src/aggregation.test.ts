import { describe, expect, it } from 'vitest';

import {
  groupSmsOccurrences,
  type MessageOccurrence
} from './aggregation.js';
import { renderSms, validateSmsTemplate } from './templates.js';

const occurrence = (
  patch: Partial<MessageOccurrence>
): MessageOccurrence => ({
  organisationId: 'org-1',
  sequenceVersionId: 'sequence-version-1',
  stageId: 'seven-days',
  invoiceId: 'inv-1',
  invoiceNumber: 'INV-1',
  customerId: 'customer-1',
  channel: 'SMS',
  scheduledAtUtc: '2026-09-17T23:00:00.000Z',
  localDate: '2026-09-18',
  amountDue: '50.00',
  currency: 'AUD',
  onlineInvoiceUrl: 'https://example.invalid/inv-1',
  ...patch
});

describe('groupSmsOccurrences', () => {
  it('consolidates SMS by customer while leaving Xero email out of SMS groups', () => {
    const groups = groupSmsOccurrences('CONSOLIDATED_CUSTOMER', [
      occurrence({}),
      occurrence({
        invoiceId: 'inv-2',
        invoiceNumber: 'INV-2',
        amountDue: '70.00',
        onlineInvoiceUrl: 'https://example.invalid/inv-2'
      }),
      occurrence({
        channel: 'XERO_EMAIL',
        invoiceId: 'inv-2',
        invoiceNumber: 'INV-2'
      })
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.invoiceIds).toEqual(['inv-1', 'inv-2']);
    expect(groups[0]?.totalDue).toBe('120');
  });

  it('creates one SMS group per invoice when configured', () => {
    const groups = groupSmsOccurrences('PER_INVOICE', [
      occurrence({}),
      occurrence({
        invoiceId: 'inv-2',
        invoiceNumber: 'INV-2',
        amountDue: '70.00'
      })
    ]);

    expect(groups.map((group) => group.invoiceIds)).toEqual([
      ['inv-1'],
      ['inv-2']
    ]);
  });

  it('rejects mixed currencies in a consolidated customer group', () => {
    expect(() =>
      groupSmsOccurrences('CONSOLIDATED_CUSTOMER', [
        occurrence({}),
        occurrence({ invoiceId: 'inv-2', currency: 'NZD' })
      ])
    ).toThrow('mixed currencies');
  });
});

describe('SMS templates', () => {
  it('splits deterministically when the configured segment limit is exceeded', () => {
    const result = renderSms(
      `{{customer_name}} ${'A'.repeat(170)}`,
      { customer_name: 'A Customer' },
      { maxSegments: 3 }
    );

    expect(result.parts.map((part) => part.prefix)).toEqual(['1/2', '2/2']);
    expect(result.encoding).toBe('GSM-7');
    expect(result.segmentCount).toBe(2);
  });

  it('reports UCS-2 for content outside the GSM character sets', () => {
    expect(
      renderSms('Hi {{customer_name}} 👋', { customer_name: 'Alex' }, {
        maxSegments: 3
      }).encoding
    ).toBe('UCS-2');
  });

  it('rejects unknown template tokens', () => {
    expect(() => validateSmsTemplate('Pay {{bank_password}}')).toThrow(
      'Unknown SMS template token: bank_password'
    );
  });
});
