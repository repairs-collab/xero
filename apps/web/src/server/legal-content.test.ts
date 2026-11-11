import { afterEach, describe, expect, it } from 'vitest';

import { legalIdentity } from './legal-content.js';

const originalEnvironment = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnvironment };
});

describe('AccountPulse support identity', () => {
  it('accepts only an HTTPS Sophie support address', () => {
    process.env.ACCOUNT_PULSE_SUPPORT_EMAIL = 'AP@motts.com.au';
    process.env.ACCOUNT_PULSE_SUPPORT_CHAT_URL = 'https://sophie.example/chat';

    expect(legalIdentity()).toMatchObject({
      supportEmail: 'AP@motts.com.au',
      supportChatUrl: 'https://sophie.example/chat'
    });

    process.env.ACCOUNT_PULSE_SUPPORT_CHAT_URL = 'javascript:alert(1)';
    expect(legalIdentity().supportChatUrl).toBeNull();
  });
});
