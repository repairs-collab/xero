import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  VoiceReminderPanel,
  VoiceReminderStart
} from '../src/app/(protected)/customers/[customerId]/voice/voice-reminder-panel.js';
import type { VoiceCallDraftView } from '../src/app/(protected)/customers/[customerId]/voice/voice-call-service.js';

const noAction = (formData: FormData): Promise<void> => {
  void formData;
  return Promise.resolve();
};

const draft = (patch: Partial<VoiceCallDraftView> = {}): VoiceCallDraftView => ({
  voiceCallId: 'voice-call-1',
  idempotencyKey: 'voice-page-123',
  allowed: true,
  blockCode: null,
  customerId: 'customer-1',
  customerName: 'Example Customer',
  destinationNumber: '+61412345678',
  destinationSource: '0412 345 678',
  outboundNumber: '+61255501234',
  callerIdentityLabel: '+61255501234',
  transferTargetLabel: 'Main office accounts queue',
  combinedAmount: '125.50',
  currency: 'AUD',
  includedInvoices: [
    {
      invoiceId: 'invoice-1',
      xeroInvoiceId: 'xero-invoice-1',
      invoiceNumber: 'INV-100',
      amountDue: '100.00',
      currency: 'AUD',
      dueDate: '2026-09-10',
      syncVersion: 10
    },
    {
      invoiceId: 'invoice-2',
      xeroInvoiceId: 'xero-invoice-2',
      invoiceNumber: 'INV-200',
      amountDue: '25.50',
      currency: 'AUD',
      dueDate: '2026-09-20',
      syncVersion: 11
    }
  ],
  excludedInvoices: [
    {
      id: 'invoice-future',
      invoiceNumber: 'INV-FUTURE',
      reasons: ['NOT_OVERDUE']
    }
  ],
  attemptsLastSevenDays: 1,
  attemptsThisMonth: 2,
  nextPermittedAt: null,
  callFlowVersion: 1,
  callFlowHash: 'sha256:flow-1',
  approvedFacts: {
    destinationNumber: '+61412345678',
    outboundNumber: '+61255501234',
    combinedAmount: '125.50',
    currency: 'AUD',
    agentId: 'agent-accountpulse',
    agentVersion: 7,
    voiceId: 'voice-au-1',
    voiceSettingsUpdatedAt: '2026-10-07T23:30:00.000Z',
    transferTargetLabel: 'Main office accounts queue',
    callFlowVersion: 1,
    callFlowHash: 'sha256:flow-1',
    invoices: []
  },
  approvedFactsHash: 'sha256:facts-1',
  ...patch
});

describe('voice reminder customer view', () => {
  it('offers one customer-level voice reminder action', () => {
    const html = renderToStaticMarkup(
      <VoiceReminderStart
        organisationId="organisation-1"
        customerId="customer-1"
        idempotencyKey="voice-page-123"
        action={noAction}
      />
    );

    expect(html.match(/Create voice reminder/g)).toHaveLength(1);
    expect(html).toContain('name="idempotencyKey" value="voice-page-123"');
  });

  it('shows protected facts and one immutable confirmation without exposing provider controls', () => {
    const html = renderToStaticMarkup(
      <VoiceReminderPanel
        organisationId="organisation-1"
        draft={draft()}
        action={noAction}
      />
    );

    expect(html).toContain('Example Customer');
    expect(html).toContain('+61412345678');
    expect(html).toContain('INV-100');
    expect(html).toContain('INV-200');
    expect(html).toContain('$125.50');
    expect(html).toContain('INV-FUTURE');
    expect(html).toContain('Not yet overdue');
    expect(html).toContain('1 attempt in the last 7 days');
    expect(html).toContain('2 attempts this month');
    expect(html).toContain('Call-flow version 1');
    expect(html).toContain('Press 1 confirms the recipient is authorised');
    expect(html).toContain('Press 2 transfers to Main office accounts queue');
    expect(html).toContain('Wrong person');
    expect(html).toContain('generic callback message');
    expect(html).toContain('Final confirmation');
    expect(html).toContain('Calling from +61255501234');
    expect(html).toContain('name="idempotencyKey" value="voice-page-123"');
    expect(html.match(/name="idempotencyKey"/g)).toHaveLength(1);
    expect(html).toContain('I confirm these exact account facts');
    expect(html).toContain('Confirm and place call');
    expect(html).not.toContain('script editor');
    expect(html).not.toContain('previewPublicKey');
    expect(html).not.toContain('Retell');
    expect(html).not.toContain('agent-accountpulse');
  });

  it('explains blocked calls, links to contact correction, and does not offer submission', () => {
    const html = renderToStaticMarkup(
      <VoiceReminderPanel
        organisationId="organisation-1"
        draft={draft({
          voiceCallId: null,
          allowed: false,
          blockCode: 'INVALID_DESTINATION',
          destinationNumber: null,
          approvedFacts: null,
          approvedFactsHash: null,
          nextPermittedAt: new Date('2026-10-09T22:00:00.000Z')
        })}
        action={noAction}
      />
    );

    expect(html).toContain('No usable voice phone number');
    expect(html).toContain('/customers/customer-1?editPhone=1#sms-phone');
    expect(html).toContain('Fix contact number');
    expect(html).toContain('Confirm and place call');
    expect(html).toContain('disabled=""');
    expect(html).not.toContain('name="approvedFactsHash"');
  });
});
