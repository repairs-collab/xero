import { describe, expect, it } from 'vitest';

import { redactCustomerBackup } from './platform-customer-backup.js';

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
});
