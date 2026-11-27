import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { DashboardView, type DashboardModel } from './dashboard-view.js';

const model: DashboardModel = {
  overdueTotal: '$1,000',
  overdueCount: 4,
  awaitingApproval: 2,
  pausedCustomers: 1,
  openEscalations: 1,
  paidAfterReminders: '$500',
  lastXeroSync: '11 Nov 2026, 9:00 am',
  xeroSyncHealth: 'CURRENT',
  messagingHealthy: true,
  supportEmail: 'ap@motts.com.au',
  supportChatUrl: 'https://sophie.example/chat'
};

describe('dashboard support', () => {
  it('shows provider-neutral AccountPulse messaging health', () => {
    const markup = renderToStaticMarkup(<DashboardView model={model} />);

    expect(markup).toContain('AccountPulse messaging ready');
    expect(markup).not.toContain('Sinch');
  });

  it('marks delayed Xero data for attention and keeps the last sync visible', () => {
    const markup = renderToStaticMarkup(
      <DashboardView model={{ ...model, xeroSyncHealth: 'DELAYED' }} />
    );

    expect(markup).toContain('Xero sync delayed');
    expect(markup).toContain('connection-panel--attention');
    expect(markup).toContain('11 Nov 2026, 9:00 am');
    expect(markup).not.toContain('Invoices, payments and customers are in sync.');
  });

  it('offers Sophie chat and a human support email', () => {
    const markup = renderToStaticMarkup(<DashboardView model={model} />);

    expect(markup).toContain('Chat with Sophie');
    expect(markup).toContain('https://sophie.example/chat');
    expect(markup).toContain('mailto:ap@motts.com.au');
    expect(markup).toContain('AI support assistant');
  });
});
