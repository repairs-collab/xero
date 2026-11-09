import { describe, expect, it } from 'vitest';

import { evaluateProxyAccess } from './proxy-policy.js';

describe('public account recovery boundary', () => {
  it('allows a conflicted identity to reach recovery without a session', () => {
    expect(evaluateProxyAccess('/account-recovery', false)).toBe('allow');
  });

  it('continues to protect operational pages', () => {
    expect(evaluateProxyAccess('/approvals', false)).toBe('login');
  });

  it('allows Stripe to deliver a signed subscription webhook without a session', () => {
    expect(evaluateProxyAccess('/api/webhooks/stripe', false)).toBe('allow');
  });

  it('allows prospective customers to open the Solo start page', () => {
    expect(evaluateProxyAccess('/start', false)).toBe('allow');
    expect(evaluateProxyAccess('/onboarding', false)).toBe('login');
  });
});
