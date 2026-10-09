import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { CustomerTimeline } from '../src/components/customer-timeline.js';

describe('voice customer timeline', () => {
  it('shows safe call milestones and a review link without provider data', () => {
    const html = renderToStaticMarkup(
      createElement(CustomerTimeline, {
        events: [
          {
            id: 'voice:event:1',
            occurredAt: '2026-10-08T01:00:00Z',
            label: 'Voice reminder delivered',
            source: 'AccountPulse Voice',
            detail: 'Invoices INV-100, INV-101 · initiated by Repairs Admin',
            tone: 'positive',
            links: [
              { href: '/invoices/invoice-100', label: 'INV-100' },
              { href: '/invoices/invoice-101', label: 'INV-101' }
            ]
          },
          {
            id: 'voice:review:1',
            occurredAt: '2026-10-08T01:01:00Z',
            label: 'Voice outcome needs review',
            source: 'AccountPulse Voice',
            detail: 'INV-100 · outcome could not be confirmed safely',
            tone: 'warning',
            href: '/escalations',
            actionLabel: 'Review escalation'
          }
        ]
      })
    );

    expect(html).toContain('Voice reminder delivered');
    expect(html).toContain('Invoices INV-100, INV-101');
    expect(html).toContain('initiated by Repairs Admin');
    expect(html).toContain('href="/invoices/invoice-100"');
    expect(html).toContain('href="/invoices/invoice-101"');
    expect(html).toContain('href="/escalations"');
    expect(html).toContain('Review escalation');
    expect(html).not.toContain('+614');
    expect(html).not.toContain('transcript');
    expect(html).not.toContain('recording');
    expect(html).not.toContain('dynamic_variables');
  });
});
