import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { VoiceTestCallPanel } from '../src/app/(protected)/settings/voice/voice-test-call-panel.js';

describe('VoiceTestCallPanel', () => {
  it('collects an invoice and staff number, then shows an explicit confirmation preview', () => {
    const html = renderToStaticMarkup(
      createElement(VoiceTestCallPanel, {
        organisationId: 'org-1',
        ready: true,
        idempotencyKey: 'request-1',
        prepareAction: vi.fn(),
        approveAction: vi.fn(),
        draft: {
          purpose: 'TEST',
          voiceCallId: 'call-1',
          idempotencyKey: 'request-1',
          invoiceNumber: 'INV-100',
          customerName: 'Existing Xero customer',
          destinationNumber: '+61400000002',
          amountDue: '123.45',
          currency: 'AUD',
          dueDate: '2026-08-31',
          ready: true
        }
      })
    );

    expect(html).toContain('Test voice call');
    expect(html).toContain('name="invoiceNumber"');
    expect(html).toContain('name="testNumber"');
    expect(html).toContain('INV-100');
    expect(html).toContain('+61400000002');
    expect(html).toContain('Existing Xero customer');
    expect(html).toContain('I confirm this number is controlled by staff');
    expect(html).toContain('Place test voice call');
    expect(html).toContain('TEST');
  });

  it('blocks preparation until provider and fictional-flow readiness are current', () => {
    const html = renderToStaticMarkup(
      createElement(VoiceTestCallPanel, {
        organisationId: 'org-1',
        ready: false,
        idempotencyKey: 'request-1',
        prepareAction: vi.fn(),
        approveAction: vi.fn(),
        draft: null
      })
    );
    expect(html).toContain('Complete the provider test and fictional flow test first');
    expect(html).toContain('disabled=""');
  });
});
