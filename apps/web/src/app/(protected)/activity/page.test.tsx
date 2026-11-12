import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const requireWebSession = vi.hoisted(() => vi.fn());
const getDatabaseClient = vi.hoisted(() => vi.fn());
const searchCustomerActivity = vi.hoisted(() => vi.fn());

vi.mock('next/headers', () => ({
  headers: () => Promise.resolve(new Headers())
}));

vi.mock('../../../server/runtime.js', () => ({
  getDatabaseClient,
  requireWebSession
}));

vi.mock('@bc5000/db/web', () => ({
  CUSTOMER_ACTIVITY_FILTER_OPTIONS: [
    { value: 'messaging', label: 'Messages and reminders' },
    { value: 'xero', label: 'Xero' }
  ],
  isCustomerActivityType: (value: string | undefined) =>
    value === 'messaging' || value === 'xero',
  PostgresActivityRepository: class {
    searchCustomerActivity = searchCustomerActivity;
  }
}));

import ActivityPage from './page.js';

describe('customer Activity page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireWebSession.mockResolvedValue({
      userId: 'customer-admin',
      memberships: [
        {
          organisationId: '00000000-0000-4000-8000-000000000001',
          role: 'ADMIN',
          active: true
        }
      ]
    });
    getDatabaseClient.mockReturnValue({ db: {} });
    searchCustomerActivity.mockResolvedValue([
      {
        id: 'safe-audit-row',
        occurredAt: new Date('2026-11-12T01:00:00.000Z'),
        label: 'Reminder approved',
        subject: 'Reminder',
        actorLabel: 'User action'
      }
    ]);
  });

  it('rejects crafted provider filters and renders only the safe audit projection', async () => {
    const markup = renderToStaticMarkup(
      await ActivityPage({
        searchParams: Promise.resolve({
          eventType: 'SINCH_CALLBACK_KEY_ROTATED'
        })
      })
    );

    expect(searchCustomerActivity).toHaveBeenCalledWith(
      '00000000-0000-4000-8000-000000000001',
      {}
    );
    expect(markup).toContain('Reminder approved');
    expect(markup).toContain('Activity type');
    expect(markup).not.toContain('SINCH_CALLBACK_KEY_ROTATED');
    expect(markup).not.toContain('Sinch');
    expect(markup).not.toContain('PROVIDER_CONNECTION');
    expect(markup).not.toContain('connection-id-private');
  });
});
