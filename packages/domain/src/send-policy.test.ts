import { describe, expect, it } from 'vitest';

import * as domain from './index.js';

type TestInput = {
  sendMode: string;
  liveSendAcknowledged: boolean;
  rolloutScope: string;
  maintenanceMode: boolean;
  source: string;
  channel: string;
  destination: string;
  recipientAllowlist: string[];
};

type TestDecision = {
  kind: 'provider-call' | 'dry-run' | 'blocked';
  reason: string;
};

const evaluate = (input: TestInput): TestDecision => {
  const candidate = (
    domain as unknown as {
      evaluateProviderSendPolicy?: (value: TestInput) => TestDecision;
    }
  ).evaluateProviderSendPolicy;
  expect(candidate).toBeTypeOf('function');
  return candidate?.(input) ?? {
    kind: 'blocked',
    reason: 'POLICY_NOT_IMPLEMENTED'
  };
};

const liveControlled = {
  sendMode: 'live',
  liveSendAcknowledged: true,
  rolloutScope: 'CONTROLLED',
  maintenanceMode: false,
  source: 'AUTOMATED_REMINDER',
  channel: 'SMS',
  destination: '+61400000001',
  recipientAllowlist: ['+61400000001']
} satisfies TestInput;

describe('provider send policy', () => {
  it('keeps global dry-run from calling a provider', () => {
    expect(
      evaluate({ ...liveControlled, sendMode: 'dry-run' })
    ).toEqual({ kind: 'dry-run', reason: 'GLOBAL_DRY_RUN' });
  });

  it('requires the live acknowledgement before provider calls', () => {
    expect(
      evaluate({ ...liveControlled, liveSendAcknowledged: false })
    ).toEqual({ kind: 'dry-run', reason: 'LIVE_NOT_ACKNOWLEDGED' });
  });

  it('blocks all provider calls during operational maintenance', () => {
    expect(
      evaluate({ ...liveControlled, maintenanceMode: true })
    ).toEqual({ kind: 'blocked', reason: 'OPERATIONAL_MAINTENANCE' });
  });

  it('allows only technical allowlist recipients in controlled scope', () => {
    expect(evaluate(liveControlled)).toEqual({
      kind: 'provider-call',
      reason: 'ALLOWED'
    });
    expect(
      evaluate({
        ...liveControlled,
        destination: '+61400000002'
      })
    ).toEqual({
      kind: 'dry-run',
      reason: 'CONTROLLED_RECIPIENT_NOT_ALLOWLISTED'
    });
  });

  it('matches allowlisted email destinations case-insensitively', () => {
    expect(
      evaluate({
        ...liveControlled,
        source: 'XERO_EMAIL',
        channel: 'XERO_EMAIL',
        destination: 'accounts@example.com',
        recipientAllowlist: ['Accounts@Example.COM']
      })
    ).toEqual({ kind: 'provider-call', reason: 'ALLOWED' });
  });

  it('requires exact normalised phone-number matching', () => {
    expect(
      evaluate({
        ...liveControlled,
        recipientAllowlist: ['0400 000 001']
      })
    ).toEqual({
      kind: 'dry-run',
      reason: 'CONTROLLED_RECIPIENT_NOT_ALLOWLISTED'
    });
  });

  it.each([
    ['AUTOMATED_REMINDER', 'SMS'],
    ['MANUAL_REMINDER', 'SMS'],
    ['ESCALATION_SMS', 'SMS'],
    ['INBOX_REPLY', 'SMS'],
    ['XERO_EMAIL', 'XERO_EMAIL']
  ] as const)(
    'allows eligible %s traffic outside the technical allowlist in customer scope',
    (source, channel) => {
      expect(
        evaluate({
          ...liveControlled,
          rolloutScope: 'CUSTOMER',
          source,
          channel,
          destination:
            channel === 'SMS'
              ? '+61499999999'
              : 'customer@example.com',
          recipientAllowlist: []
        })
      ).toEqual({ kind: 'provider-call', reason: 'ALLOWED' });
    }
  );

  it('keeps Test SMS allowlist-only in customer scope', () => {
    expect(
      evaluate({
        ...liveControlled,
        rolloutScope: 'CUSTOMER',
        source: 'TEST_SMS',
        destination: '+61499999999',
        recipientAllowlist: []
      })
    ).toEqual({
      kind: 'dry-run',
      reason: 'TEST_SMS_RECIPIENT_NOT_ALLOWLISTED'
    });
    expect(
      evaluate({
        ...liveControlled,
        rolloutScope: 'CUSTOMER',
        source: 'TEST_SMS'
      })
    ).toEqual({ kind: 'provider-call', reason: 'ALLOWED' });
  });

  it.each([
    { rolloutScope: 'UNKNOWN' },
    { sendMode: 'paused' },
    { source: 'UNSUPPORTED' },
    { channel: 'FAX' },
    { sendMode: 'dry-run', rolloutScope: 'CUSTOMER' }
  ])('blocks unsupported sending state %#', (override) => {
    expect(evaluate({ ...liveControlled, ...override })).toEqual({
      kind: 'blocked',
      reason: 'UNSUPPORTED_SENDING_STATE'
    });
  });
});
