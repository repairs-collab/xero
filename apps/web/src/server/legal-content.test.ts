import { afterEach, describe, expect, it } from 'vitest';

import { legalIdentity } from './legal-content.js';

const originalEnvironment = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnvironment };
});

describe('AccountPulse support identity', () => {
  it('publishes the confirmed Australian owner identity', () => {
    delete process.env.ACCOUNT_PULSE_LEGAL_ENTITY;
    expect(legalIdentity()).toMatchObject({
      entity: 'Swan Hill Appliance Repairs Pty Ltd',
      abn: '86 633 952 333',
      acn: '633 952 333',
      address: '3 Cobb Court, Swan Hill VIC 3585',
      supportEmail: 'ap@motts.com.au',
      complaintsEmail: 'info@motts.com.au'
    });
  });

  it('accepts only an HTTPS Sophie support address', () => {
    process.env.ACCOUNT_PULSE_SUPPORT_EMAIL = 'ap@motts.com.au';
    process.env.ACCOUNT_PULSE_SUPPORT_CHAT_URL = 'https://sophie.example/chat';

    expect(legalIdentity()).toMatchObject({
      supportEmail: 'ap@motts.com.au',
      supportChatUrl: 'https://sophie.example/chat'
    });

    process.env.ACCOUNT_PULSE_SUPPORT_CHAT_URL = 'javascript:alert(1)';
    expect(legalIdentity().supportChatUrl).toBeNull();
  });
});
