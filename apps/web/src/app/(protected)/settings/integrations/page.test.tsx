import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const requireWebSession = vi.hoisted(() => vi.fn());
const getDatabaseClient = vi.hoisted(() => vi.fn());

vi.mock('next/headers', () => ({
  headers: () => Promise.resolve(new Headers())
}));

vi.mock('../../../../server/runtime.js', () => ({
  getDatabaseClient,
  requireWebSession
}));

vi.mock('./actions.js', () => ({
  disconnectXero: vi.fn(),
  requestXeroSync: vi.fn()
}));

import IntegrationsPage from './page.js';

const selectResult = (rows: unknown[], terminal: 'limit' | 'orderBy') => ({
  from: () => ({
    where: () =>
      terminal === 'limit'
        ? { limit: () => Promise.resolve(rows) }
        : { orderBy: () => Promise.resolve(rows) }
  })
});

describe('customer Xero connection page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireWebSession.mockResolvedValue({
      userId: 'customer-admin',
      cognitoSubject: 'customer-subject',
      displayName: 'Customer Admin',
      expiresAt: '2026-12-01T00:00:00.000Z',
      memberships: [
        {
          organisationId: '00000000-0000-4000-8000-000000000001',
          role: 'ADMIN',
          active: true,
          organisationStatus: 'ACTIVE'
        }
      ]
    });
    const select = vi
      .fn()
      .mockReturnValueOnce(selectResult([{ enabled: false }], 'limit'))
      .mockReturnValueOnce(
        selectResult([{ status: 'CONNECTED' }], 'limit')
      )
      .mockReturnValueOnce(
        selectResult(
          [
            {
              afterValue: {
                provider: 'XERO',
                requiredScopes: ['invoices', 'contacts', 'settings']
              }
            }
          ],
          'orderBy'
        )
      );
    getDatabaseClient.mockReturnValue({ db: { select } });
  });

  it('renders only customer Xero controls and no SMS-provider plumbing', async () => {
    const markup = renderToStaticMarkup(await IntegrationsPage());

    expect(markup).toContain('Xero connection');
    expect(markup).toContain('Reconnect Xero');
    expect(markup).toContain('Sync Xero now');
    expect(markup).not.toContain('Sinch');
    expect(markup).not.toContain('AWS Secrets Manager');
    expect(markup).not.toContain('Callback public-key');
    expect(markup).not.toContain('Test connection');
  });
});
