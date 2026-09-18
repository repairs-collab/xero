import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';

import { DashboardView } from '../src/components/dashboard-view.js';

describe('DashboardView', () => {
  it('shows action counts and labels paid-after-reminder without causal language', () => {
    const html = renderToStaticMarkup(
      createElement(DashboardView, {
        model: {
          overdueTotal: '$84,260',
          overdueCount: 42,
          awaitingApproval: 7,
          pausedCustomers: 3,
          openEscalations: 2,
          paidAfterReminders: '$12,400',
          lastXeroSync: '18 Sep 2026, 10:05 am',
          xeroHealthy: true,
          sinchHealthy: true
        }
      })
    );

    expect(html).toContain('$84,260');
    expect(html).toContain('Awaiting approval');
    expect(html).toContain('Paid after reminders');
    expect(html).not.toContain('Recovered because of reminders');
    expect(html).toContain('Xero connected');
    expect(html).toContain('Sinch connected');
  });
});
