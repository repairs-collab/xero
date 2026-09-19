import { describe, expect, it } from 'vitest';

import { resolveEffectivePause } from './pauses.js';

const now = '2026-09-18T00:00:00Z';

describe('resolveEffectivePause', () => {
  it('prioritises a customer dispute over invoice and sequence pauses', () => {
    expect(
      resolveEffectivePause({
        now,
        pauses: [
          {
            kind: 'SEQUENCE',
            scope: 'sequence',
            active: true,
            startedAt: '2026-09-16T00:00:00Z'
          },
          {
            kind: 'INVOICE',
            scope: 'invoice',
            active: true,
            startedAt: '2026-09-17T00:00:00Z'
          },
          {
            kind: 'DISPUTE',
            scope: 'customer',
            active: true,
            startedAt: '2026-09-18T00:00:00Z'
          }
        ]
      })?.kind
    ).toBe('DISPUTE');
  });

  it('prioritises SMS suppression over every temporary pause', () => {
    expect(
      resolveEffectivePause({
        now,
        pauses: [
          {
            kind: 'DISPUTE',
            scope: 'customer',
            active: true,
            startedAt: '2026-09-18T00:00:00Z'
          },
          {
            kind: 'SMS_SUPPRESSION',
            scope: 'customer',
            active: true,
            startedAt: '2026-09-01T00:00:00Z',
            reason: 'Customer opted out'
          }
        ]
      })
    ).toMatchObject({
      kind: 'SMS_SUPPRESSION',
      scope: 'customer',
      reason: 'Customer opted out'
    });
  });

  it('uses promise, manual customer, invoice, then sequence precedence', () => {
    const pauses = [
      {
        kind: 'SEQUENCE' as const,
        scope: 'sequence' as const,
        active: true,
        startedAt: '2026-09-01T00:00:00Z'
      },
      {
        kind: 'INVOICE' as const,
        scope: 'invoice' as const,
        active: true,
        startedAt: '2026-09-02T00:00:00Z'
      },
      {
        kind: 'CUSTOMER' as const,
        scope: 'customer' as const,
        active: true,
        startedAt: '2026-09-03T00:00:00Z'
      },
      {
        kind: 'PROMISE_TO_PAY' as const,
        scope: 'customer' as const,
        active: true,
        startedAt: '2026-09-04T00:00:00Z',
        expiresAt: '2026-09-20T00:00:00Z'
      }
    ];

    expect(resolveEffectivePause({ now, pauses })?.kind).toBe('PROMISE_TO_PAY');
    expect(
      resolveEffectivePause({
        now,
        pauses: pauses.filter((pause) => pause.kind !== 'PROMISE_TO_PAY')
      })?.kind
    ).toBe('CUSTOMER');
  });

  it('ignores an expired promise-to-pay after its grace period', () => {
    expect(
      resolveEffectivePause({
        now,
        pauses: [
          {
            kind: 'PROMISE_TO_PAY',
            scope: 'customer',
            active: true,
            startedAt: '2026-09-01T00:00:00Z',
            expiresAt: '2026-09-17T23:59:59Z'
          }
        ]
      })
    ).toBeNull();
  });

  it('ignores inactive pauses', () => {
    expect(
      resolveEffectivePause({
        now,
        pauses: [
          {
            kind: 'REPLY',
            scope: 'customer',
            active: false,
            startedAt: '2026-09-18T00:00:00Z'
          }
        ]
      })
    ).toBeNull();
  });
});
