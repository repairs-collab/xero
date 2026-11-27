import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

const selectResult = (rows: unknown[], terminal: 'limit' | 'orderBy') => {
  const where = () => ({ [terminal]: () => Promise.resolve(rows) });
  return { from: () => ({ where, leftJoin: () => ({ where }) }) };
};

const setXeroRows = ({
  edition = 'SOLO',
  legacyEnabled = false,
  oauthStatus = 'CONNECTED',
  lastSuccessfulSyncAt = null
}: {
  edition?: 'SOLO' | 'INTERNAL_LEGACY';
  legacyEnabled?: boolean;
  oauthStatus?: 'CONNECTED' | 'REAUTH_REQUIRED' | 'DISCONNECTED' | null;
  lastSuccessfulSyncAt?: Date | null;
} = {}) => {
  const select = vi
    .fn()
    .mockReturnValueOnce(selectResult([{ enabled: legacyEnabled }], 'limit'))
    .mockReturnValueOnce(
      selectResult(
        [{ edition, lastSuccessfulSyncAt, timeZone: 'Australia/Sydney', oauthStatus }],
        'limit'
      )
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
};

describe('customer Xero connection page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-27T03:00:00.000Z'));
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
    setXeroRows();
  });

  afterEach(() => vi.useRealTimers());

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

  it('shows that a verified legacy connection has a delayed sync', async () => {
    const lastSuccessfulSyncAt = new Date('2026-11-20T02:30:00.000Z');
    setXeroRows({
      edition: 'INTERNAL_LEGACY',
      legacyEnabled: true,
      oauthStatus: null,
      lastSuccessfulSyncAt
    });

    const markup = renderToStaticMarkup(await IntegrationsPage());

    expect(markup).toContain('Xero sync delayed');
    expect(markup).toContain('Legacy Custom Connection');
    expect(markup).toContain('Legacy verified');
    expect(markup).toContain('Last successful sync');
    expect(markup).toContain(lastSuccessfulSyncAt.toISOString());
    expect(markup).not.toContain('status-dot--ok');
    expect(markup).toContain('Sync Xero now');
  });

  it('shows that connected OAuth still needs its first sync', async () => {
    const markup = renderToStaticMarkup(await IntegrationsPage());

    expect(markup).toContain('Xero first sync pending');
    expect(markup).toContain('No successful sync recorded');
    expect(markup).toContain('Granted');
    expect(markup).toContain('Sync Xero now');
  });

  it('offers reconnection when customer OAuth access requires renewal', async () => {
    setXeroRows({
      oauthStatus: 'REAUTH_REQUIRED',
      lastSuccessfulSyncAt: new Date('2026-11-27T02:55:00.000Z')
    });

    const markup = renderToStaticMarkup(await IntegrationsPage());

    expect(markup).toContain('Xero reconnection required');
    expect(markup).toContain('Reconnect Xero');
    expect(markup).not.toContain('Sync Xero now');
    expect(markup).not.toContain('status-dot--ok');
  });
});
