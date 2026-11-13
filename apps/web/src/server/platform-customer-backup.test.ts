import { describe, expect, it, vi } from 'vitest';

import {
  createPlatformCustomerBackupService,
  redactCustomerBackup
} from './platform-customer-backup.js';

describe('customer backup redaction', () => {
  it('removes credentials, tokens, OTP values and raw provider payloads recursively', () => {
    const value = redactCustomerBackup({
      email: 'customer@example.com',
      encrypted_refresh_token: { ciphertext: 'secret-token' },
      admin_mobile_otp_hash: 'otp-hash',
      nested: {
        api_secret: 'api-secret',
        provider_payload: { Authorization: 'Bearer hidden' },
        invoice_number: 'INV-100'
      }
    });
    const encoded = JSON.stringify(value);

    expect(encoded).toContain('customer@example.com');
    expect(encoded).toContain('INV-100');
    expect(encoded).not.toContain('secret-token');
    expect(encoded).not.toContain('otp-hash');
    expect(encoded).not.toContain('api-secret');
    expect(encoded).not.toContain('Bearer hidden');
  });

  it('includes tenant-scoped verified-request evidence in an owner export', async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ id: 'organisation-1' }] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: '11111111-1111-4111-8111-111111111111',
            request_type: 'EXPORT'
          }
        ]
      })
      .mockResolvedValue({ rows: [] });
    const values = vi.fn().mockResolvedValue(undefined);
    const service = createPlatformCustomerBackupService({
      verifyOwner: () => Promise.resolve(true),
      database: { execute, insert: () => ({ values }) } as never,
      clock: { now: () => new Date('2026-09-18T00:00:00.000Z') }
    });

    const backup = (await service.createBackup(
      'owner-user',
      'organisation-1',
      { requestId: '11111111-1111-4111-8111-111111111111' }
    )) as { data: Record<string, unknown> };

    expect(backup.data).toHaveProperty('retention_cases');
    expect(backup.data).toHaveProperty('data_request_cases');
    expect(values).toHaveBeenCalledWith({
      actorUserId: 'owner-user',
      targetOrganisationId: 'organisation-1',
      eventType: 'PLATFORM_CUSTOMER_BACKUP_DOWNLOADED',
      entityType: 'DATA_REQUEST',
      entityId: '11111111-1111-4111-8111-111111111111',
      reason: 'Owner delivered verified customer export',
      beforeValue: null,
      afterValue: {
        format: 'ACCOUNT_PULSE_JSON_V1',
        generatedAt: '2026-09-18T00:00:00.000Z',
        requestId: '11111111-1111-4111-8111-111111111111'
      },
      occurredAt: new Date('2026-09-18T00:00:00.000Z')
    });
  });
});
