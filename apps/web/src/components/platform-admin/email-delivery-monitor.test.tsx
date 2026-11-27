import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { EmailDeliveryMonitor } from './email-delivery-monitor.js';

describe('owner email delivery monitor', () => {
  it('renders allowlisted operational evidence without exposing unsafe row fields or controls', () => {
    const snapshot = {
      metrics: { pendingOrRetry: 2, unknown: 1, failedLast24Hours: 3, sentLast24Hours: 4 },
      rows: [{
        id: 'notice-1', organisationId: 'organisation-1', organisationName: '<script>private</script>',
        template: 'PAYMENT_FAILED', status: 'UNKNOWN', attempts: 1,
        availableAt: new Date('2026-11-22T00:00:00.000Z'),
        expiresAt: new Date('2026-11-29T00:00:00.000Z'), nextAttemptAt: null,
        lastAttemptedAt: new Date('2026-11-22T00:01:00.000Z'), sentAt: null,
        createdAt: new Date('2026-11-22T00:00:00.000Z'),
        updatedAt: new Date('2026-11-22T00:01:00.000Z'),
        failureCategory: 'DELIVERY_UNCERTAIN',
        recipient: 'must-not-render@example.invalid', renderData: { secret: 'private-render-data' },
        idempotencyKey: 'private-idempotency', sourceId: 'private-source',
        messageId: '<private@motts.com.au>', providerMessageId: 'private-provider-id'
      }]
    } as never;

    const html = renderToStaticMarkup(<EmailDeliveryMonitor snapshot={snapshot} />);

    expect(html).toContain('Email delivery');
    expect(html).toContain('Pending or retrying');
    expect(html).toContain('Manual investigation required');
    expect(html).toContain('Payment failed');
    expect(html).toContain('&lt;script&gt;private&lt;/script&gt;');
    expect(html).not.toContain('<script>private</script>');
    for (const secret of [
      'must-not-render@example.invalid', 'private-render-data', 'private-idempotency',
      'private-source', 'private@motts.com.au', 'private-provider-id'
    ]) expect(html).not.toContain(secret);
    expect(html).not.toMatch(/<button|resend|download/i);
  });

  it('uses a safe activation-cancellation label', () => {
    const snapshot = {
      metrics: { pendingOrRetry: 0, unknown: 0, failedLast24Hours: 0, sentLast24Hours: 0 },
      rows: [{
        id: 'notice-2', organisationId: 'organisation-2', organisationName: 'Beta Repairs',
        template: 'WORKSPACE_WELCOME', status: 'CANCELLED', attempts: 0,
        availableAt: new Date('2026-11-22T00:00:00.000Z'),
        expiresAt: new Date('2026-12-22T00:00:00.000Z'), nextAttemptAt: null,
        lastAttemptedAt: null, sentAt: null, createdAt: new Date('2026-11-22T00:00:00.000Z'),
        updatedAt: new Date('2026-11-22T00:01:00.000Z'), failureCategory: 'PRE_ACTIVATION'
      }]
    } as const;
    expect(renderToStaticMarkup(<EmailDeliveryMonitor snapshot={snapshot} />))
      .toContain('Cancelled before email activation');
  });
});
