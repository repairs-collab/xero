import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('subscription repository safety wiring', () => {
  const source = readFileSync(new URL('./subscription-repository.ts', import.meta.url), 'utf8');
  it('checks the latest applied checkout while holding subscription locks', () => {
    expect(
      source.match(
        /latestAppliedCheckoutAt\(\s*transaction,\s*input\.organisationId\s*\)/g
      )
    ).toHaveLength(2);
    expect(source).toContain('lastAppliedCheckoutAt: latestCheckoutAt');
    expect(source).toContain("eq(subscriptionEvents.eventType, 'checkout.session.completed')");
    expect(source).toContain("eq(subscriptionEvents.outcome, 'APPLIED')");
    expect(source).toContain('desc(subscriptionEvents.stripeEventCreatedAt)');
  });
  it('retains the local trial deadline and checks retired subscription IDs', () => {
    expect(source).toContain('retainedTrialEnd(subscription.trialEndsAt, input.trialEndsAt)');
    expect(source).toContain('retiredStripeSubscriptions');
    expect(source).toContain('incomingStatus: input.status');
  });
});
