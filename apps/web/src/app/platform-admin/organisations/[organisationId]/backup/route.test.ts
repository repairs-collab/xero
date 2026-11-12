import { NextRequest } from 'next/server';
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createBackup: vi.fn().mockResolvedValue({
    organisation: { name: 'Alpha Repairs' },
    generatedAt: '2026-11-12T00:00:00.000Z'
  })
}));

vi.mock('../../../../../server/runtime.js', () => ({
  getDatabaseClient: () => ({ db: {} })
}));

vi.mock('../../../../../server/platform-authorization.js', () => ({
  isPlatformOwner: vi.fn(),
  requirePlatformOwner: () => Promise.resolve({ userId: 'verified-owner' })
}));

vi.mock('../../../../../server/platform-customer-backup.js', () => ({
  createPlatformCustomerBackupService: () => ({
    createBackup: mocks.createBackup
  })
}));

import { GET } from './route.js';

describe('request-bound customer backup route', () => {
  it('binds the downloaded export to the exact verified request', async () => {
    const response = await GET(
      new NextRequest(
        'https://ap.motts.com.au/platform-admin/organisations/11111111-1111-4111-8111-111111111111/backup?requestId=22222222-2222-4222-8222-222222222222'
      ),
      {
        params: Promise.resolve({
          organisationId: '11111111-1111-4111-8111-111111111111'
        })
      }
    );

    expect(response.status).toBe(200);
    expect(mocks.createBackup).toHaveBeenCalledWith(
      'verified-owner',
      '11111111-1111-4111-8111-111111111111',
      { requestId: '22222222-2222-4222-8222-222222222222' }
    );
  });
});
