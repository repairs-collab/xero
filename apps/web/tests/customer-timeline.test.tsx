import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { CustomerTimeline } from '../src/components/customer-timeline.js';

describe('CustomerTimeline', () => {
  it('orders heterogeneous events newest-first and labels their source', () => {
    const html = renderToStaticMarkup(createElement(CustomerTimeline, { events: [
      { id: 'reply', occurredAt: '2026-09-18T08:00:00Z', label: 'Customer replied', source: 'Sinch', detail: 'Can we pay Friday?' },
      { id: 'invoice', occurredAt: '2026-09-18T10:00:00Z', label: 'Xero invoice updated', source: 'Xero', detail: 'Balance changed' },
      { id: 'delivery', occurredAt: '2026-09-18T09:00:00Z', label: 'SMS delivered', source: 'Sinch', detail: 'Delivered to mobile' }
    ] }));
    expect(html.indexOf('Xero invoice updated')).toBeLessThan(html.indexOf('SMS delivered'));
    expect(html.indexOf('SMS delivered')).toBeLessThan(html.indexOf('Customer replied'));
    expect(html).toContain('data-testid="timeline-event"');
    expect(html).toContain('Xero');
    expect(html).toContain('Sinch');
  });
});
