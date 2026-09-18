import { describe, expect, it } from 'vitest';

import { redact } from './redaction.js';

describe('redact', () => {
  it('redacts secrets, message content, email, and phone values recursively', () => {
    expect(redact({ apiSecret: 'secret', content: 'Pay now', nested: { email: 'a@example.com', phone: '+61400000000' } })).toEqual({ apiSecret: '[REDACTED]', content: '[REDACTED]', nested: { email: '[REDACTED]', phone: '[REDACTED]' } });
  });

  it('redacts matching keys inside arrays without mutating the input', () => {
    const input = { items: [{ destination: '+61400000000', status: 'queued' }], authorization: 'Bearer token' };
    expect(redact(input)).toEqual({ items: [{ destination: '[REDACTED]', status: 'queued' }], authorization: '[REDACTED]' });
    expect(input.items[0]?.destination).toBe('+61400000000');
  });
});
