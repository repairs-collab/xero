import { describe, expect, it, vi } from 'vitest';
import { PostgresEntitlementRepository, PostgresSmsCommerceRepository, type Database } from '@bc5000/db';
import { decideAccountEntitlements } from '@bc5000/domain';
import { dispatchWithProviderSendLock } from './provider-send-policy.js';

describe('provider send lock billing cutoff', () => {
  it('checks the time after delayed final entitlement reads', async () => {
    const boundary = new Date('2026-11-10T00:00:00Z');
    let current = new Date(boundary.getTime() - 1);
    let selections = 0;
    const chain = { from: () => chain, where: () => chain, for: () => chain, limit: () => Promise.resolve(++selections === 1 ? [{ sendMode: 'live', rolloutScope: 'CUSTOMER', liveSendAcknowledged: true, maintenanceMode: false, recipientAllowlist: [] }] : []) };
    const transaction = { select: () => chain };
    const database = { transaction: (work: (tx: typeof transaction) => unknown) => work(transaction) } as unknown as Database;
    let reads = 0;
    const decide = vi.spyOn(PostgresEntitlementRepository.prototype, 'decide').mockImplementation((_org, now) => {
      if (++reads === 2) current = boundary;
      const decisionTime = typeof now === 'function' ? now() : now;
      return Promise.resolve(decideAccountEntitlements({ edition: 'SOLO', platformStatus: 'ACTIVE', subscriptionStatus: 'CANCEL_AT_PERIOD_END', stripeProviderStatus: 'active', currentPeriodEnd: boundary, cancelAt: null, trialEndsAt: null, onboardingCompletedVersion: 1, requiredOnboardingVersion: 1, replyNumberReady: true, verifiedAdminMobile: null, acceptedTrialTestSmsParts: 0, now: decisionTime }));
    });
    const provider = vi.fn<() => Promise<string>>().mockResolvedValue('sent');
    try {
      const result = await dispatchWithProviderSendLock(database, { organisationId: 'org', source: 'XERO_EMAIL', channel: 'XERO_EMAIL', destination: 'person@example.com', now: current, clock: { now: () => current } }, async (_tx, context) => {
        await context.assertEntitlement();
        return provider();
      });
      expect(result.kind).toBe('blocked');
      expect(provider).not.toHaveBeenCalled();
    } finally { decide.mockRestore(); }
  });

  it.each([
    ['TEST_SMS', 'blocked'],
    ['VERIFICATION_OTP', 'dispatched']
  ] as const)('rechecks %s at trial expiry without removing the verification exemption', async (source, expected) => {
    const boundary = new Date('2026-11-10T00:00:00Z');
    let current = new Date(boundary.getTime() - 1);
    const chain = { from: () => chain, where: () => chain, for: () => chain, limit: () => Promise.resolve([{ maintenanceMode: false }]) };
    const transaction = { select: () => chain };
    const database = { transaction: (work: (tx: typeof transaction) => unknown) => work(transaction) } as unknown as Database;
    const decide = vi.spyOn(PostgresEntitlementRepository.prototype, 'decide').mockImplementation((_org, now) => Promise.resolve(decideAccountEntitlements({ edition: 'SOLO', platformStatus: 'ACTIVE', subscriptionStatus: 'TRIALING', trialEndsAt: boundary, onboardingCompletedVersion: null, requiredOnboardingVersion: 1, replyNumberReady: false, verifiedAdminMobile: '+61412345678', acceptedTrialTestSmsParts: 0, now: typeof now === 'function' ? now() : now })));
    const provider = vi.fn<() => Promise<string>>().mockResolvedValue('sent');
    try {
      const result = await dispatchWithProviderSendLock(database, { organisationId: 'org', source, channel: 'SMS', destination: '+61412345678', smsPartCount: 1, now: current, clock: { now: () => current } }, async (_tx, context) => {
        current = boundary;
        await context.assertEntitlement();
        return provider();
      });
      expect(result.kind).toBe(expected);
      expect(provider).toHaveBeenCalledTimes(expected === 'dispatched' ? 1 : 0);
      expect(decide).toHaveBeenCalledTimes(2);
    } finally { decide.mockRestore(); }
  });

  it.each([
    ['MANUAL_REMINDER', 'SMS'],
    ['XERO_EMAIL', 'XERO_EMAIL'],
    ['INBOX_REPLY', 'SMS'],
    ['TEST_SMS', 'SMS']
  ] as const)('blocks %s %s if the cutoff passes before the provider call', async (source, channel) => {
    const boundary = new Date('2026-11-10T00:00:00Z');
    let current = new Date(boundary.getTime() - 1);
    let selections = 0;
    const chain = { from: () => chain, where: () => chain, for: () => chain, limit: () => Promise.resolve(++selections === 1 ? [{ sendMode: 'live', rolloutScope: 'CUSTOMER', liveSendAcknowledged: true, maintenanceMode: false, recipientAllowlist: ['+61412345678'] }] : []) };
    const transaction = { select: () => chain };
    const database = { transaction: (work: (tx: typeof transaction) => unknown) => work(transaction) } as unknown as Database;
    const decide = vi.spyOn(PostgresEntitlementRepository.prototype, 'decide').mockImplementation((_org, now) => Promise.resolve(decideAccountEntitlements({ edition: 'SOLO', platformStatus: 'ACTIVE', subscriptionStatus: 'CANCEL_AT_PERIOD_END', stripeProviderStatus: 'active', currentPeriodEnd: boundary, cancelAt: null, trialEndsAt: null, onboardingCompletedVersion: 1, requiredOnboardingVersion: 1, replyNumberReady: true, verifiedAdminMobile: null, acceptedTrialTestSmsParts: 0, now: typeof now === 'function' ? now() : now })));
    const reserve = vi.spyOn(PostgresSmsCommerceRepository.prototype, 'reserveUsage').mockResolvedValue({ kind: 'reserved', sourceNumber: '+61400000009', warningThresholdReached: false, alreadyReserved: false });
    const release = vi.spyOn(PostgresSmsCommerceRepository.prototype, 'releaseUsage').mockResolvedValue();
    const provider = vi.fn<() => Promise<string>>().mockResolvedValue('sent');
    try {
      const result = await dispatchWithProviderSendLock(database, { organisationId: 'org', source, channel, destination: '+61412345678', outboundMessageId: 'outbound', smsPartCount: 1, now: current, clock: { now: () => current } }, async (_tx, context) => {
        current = boundary;
        await context.assertEntitlement();
        return provider();
      });
      expect(result.kind).toBe('blocked');
      expect(decide).toHaveBeenCalledTimes(2);
      expect(provider).not.toHaveBeenCalled();
      if (channel === 'SMS') expect(release).toHaveBeenCalledWith('org', 'outbound', boundary, transaction);
      else expect(release).not.toHaveBeenCalled();
    } finally { decide.mockRestore(); reserve.mockRestore(); release.mockRestore(); }
  });

  it('blocks the provider call when the cutoff passes while waiting for the organisation lock', async () => {
    const boundary = new Date('2026-11-10T00:00:00Z');
    const before = new Date(boundary.getTime() - 1);
    const chain = { from: () => chain, where: () => chain, for: () => chain, limit: () => Promise.resolve([{ sendMode: 'live', rolloutScope: 'CUSTOMER', liveSendAcknowledged: true, maintenanceMode: false, recipientAllowlist: [] }]) };
    const transaction = { select: () => chain };
    const database = { transaction: (work: (tx: typeof transaction) => unknown) => work(transaction) } as unknown as Database;
    const decide = vi.spyOn(PostgresEntitlementRepository.prototype, 'decide').mockImplementation((_org, now) => Promise.resolve(decideAccountEntitlements({
      edition: 'SOLO', platformStatus: 'ACTIVE', subscriptionStatus: 'CANCEL_AT_PERIOD_END', stripeProviderStatus: 'active', currentPeriodEnd: boundary, cancelAt: null, trialEndsAt: null, onboardingCompletedVersion: 1, requiredOnboardingVersion: 1, replyNumberReady: true, verifiedAdminMobile: null, acceptedTrialTestSmsParts: 0, now: typeof now === 'function' ? now() : now
    })));
    const dispatch = vi.fn().mockResolvedValue('sent');
    try {
      const result = await dispatchWithProviderSendLock(database, { organisationId: 'org', source: 'MANUAL_REMINDER', channel: 'SMS', destination: '+61412345678', now: before, clock: { now: () => boundary } }, dispatch);
      expect(result).toEqual({ kind: 'blocked', reason: 'SUBSCRIPTION_REQUIRED' });
      expect(dispatch).not.toHaveBeenCalled();
    } finally { decide.mockRestore(); }
  });
});
