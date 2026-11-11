import { describe, expect, it, vi } from 'vitest';

import type { DbTransaction } from '../connection.js';
import {
  organisations,
  smsAllowanceSettings,
  smsNumberPool,
  smsUsageLedger,
  subscriptions
} from '../schema/index.js';
import { PostgresSmsCommerceRepository } from './sms-commerce-repository.js';

const periodStart = new Date('2026-11-01T00:00:00.000Z');
const periodEnd = new Date('2026-12-01T00:00:00.000Z');
const now = new Date('2026-11-10T00:00:00.000Z');

interface FakeExecutorOptions {
  includedParts: number;
  entries: Array<{ entryType: 'RESERVE' | 'COMMIT' | 'RELEASE' | 'ADJUST'; partDelta: number }>;
  existingReservation?: {
    partDelta: number;
    billingPeriodStart: Date;
    billingPeriodEnd: Date;
  };
}

class FakeSelectQuery implements PromiseLike<unknown[]> {
  private table: unknown;

  constructor(
    private readonly selection: Record<string, unknown> | undefined,
    private readonly options: FakeExecutorOptions
  ) {}

  from(table: unknown): this {
    this.table = table;
    return this;
  }

  where(): this {
    return this;
  }

  for(): this {
    return this;
  }

  limit(): Promise<unknown[]> {
    return Promise.resolve(this.rows());
  }

  then<TResult1 = unknown[], TResult2 = never>(
    onfulfilled?: ((value: unknown[]) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): Promise<TResult1 | TResult2> {
    return Promise.resolve(this.rows()).then(onfulfilled, onrejected);
  }

  private rows(): unknown[] {
    if (this.table === organisations) return [{ edition: 'SOLO' }];
    if (this.table === subscriptions) {
      return [{ currentPeriodStart: periodStart, currentPeriodEnd: periodEnd }];
    }
    if (this.table === smsNumberPool) return [{ e164Number: '+61400000001' }];
    if (this.table === smsAllowanceSettings) {
      return [{
        includedParts: this.options.includedParts,
        warningPercent: 80,
        overageEnabled: true,
        overageCapCents: 100_000,
        overageCentsPerPart: 1
      }];
    }
    if (this.table === smsUsageLedger) {
      if (this.selection !== undefined && 'id' in this.selection) {
        return this.options.existingReservation === undefined
          ? []
          : [{ id: 'existing-reservation', ...this.options.existingReservation }]
      }
      return this.options.entries;
    }
    throw new Error('Unexpected fake query table');
  }
}

const createExecutor = (options: FakeExecutorOptions) => {
  const insertedUsage: unknown[] = [];
  const select = vi.fn((selection?: Record<string, unknown>) =>
    new FakeSelectQuery(selection, options)
  );
  const insert = vi.fn((table: unknown) => ({
    values: (value: unknown) => {
      if (table === smsUsageLedger) insertedUsage.push(value);
      return { onConflictDoNothing: () => Promise.resolve() };
    }
  }));
  return {
    executor: { select, insert } as unknown as DbTransaction,
    insertedUsage
  };
};

describe('PostgresSmsCommerceRepository hard allowance', () => {
  it('blocks a crossing send despite valid persisted legacy overage settings', async () => {
    const { executor, insertedUsage } = createExecutor({
      includedParts: 2_000,
      entries: [{ entryType: 'RESERVE', partDelta: 1_999 }]
    });
    const repository = new PostgresSmsCommerceRepository({} as never);

    await expect(
      repository.reserveUsage(
        {
          organisationId: 'org-solo',
          outboundMessageId: 'outbound-crossing',
          source: 'MANUAL_REMINDER',
          partCount: 2,
          now
        },
        executor
      )
    ).resolves.toEqual({
      kind: 'blocked',
      reason: 'SMS_ALLOWANCE_EXHAUSTED',
      projectedParts: 2_001
    });
    expect(insertedUsage).toEqual([]);
  });

  it('allows an exact-boundary retry without creating a second reservation', async () => {
    const { executor, insertedUsage } = createExecutor({
      includedParts: 2_000,
      entries: [
        { entryType: 'RESERVE', partDelta: 1_998 },
        { entryType: 'COMMIT', partDelta: 1_998 },
        { entryType: 'RESERVE', partDelta: 2 }
      ],
      existingReservation: {
        partDelta: 2,
        billingPeriodStart: periodStart,
        billingPeriodEnd: periodEnd
      }
    });
    const repository = new PostgresSmsCommerceRepository({} as never);

    await expect(
      repository.reserveUsage(
        {
          organisationId: 'org-solo',
          outboundMessageId: 'outbound-exact-retry',
          source: 'MANUAL_REMINDER',
          partCount: 2,
          now
        },
        executor
      )
    ).resolves.toEqual({
      kind: 'reserved',
      sourceNumber: '+61400000001',
      warningThresholdReached: false,
      alreadyReserved: true
    });
    expect(insertedUsage).toEqual([]);
  });

  it('blocks a retry of a legacy reservation that already exceeds the allowance', async () => {
    const { executor, insertedUsage } = createExecutor({
      includedParts: 2_000,
      entries: [{ entryType: 'RESERVE', partDelta: 2_001 }],
      existingReservation: {
        partDelta: 2_001,
        billingPeriodStart: periodStart,
        billingPeriodEnd: periodEnd
      }
    });
    const repository = new PostgresSmsCommerceRepository({} as never);

    await expect(
      repository.reserveUsage(
        {
          organisationId: 'org-solo',
          outboundMessageId: 'outbound-legacy-retry',
          source: 'MANUAL_REMINDER',
          partCount: 2_001,
          now
        },
        executor
      )
    ).resolves.toEqual({
      kind: 'blocked',
      reason: 'SMS_ALLOWANCE_EXHAUSTED',
      projectedParts: 2_001
    });
    expect(insertedUsage).toEqual([]);
  });

  it('blocks a retry when the rendered part count differs from its reservation', async () => {
    const { executor, insertedUsage } = createExecutor({
      includedParts: 2_000,
      entries: [{ entryType: 'RESERVE', partDelta: 1 }],
      existingReservation: {
        partDelta: 1,
        billingPeriodStart: periodStart,
        billingPeriodEnd: periodEnd
      }
    });
    const repository = new PostgresSmsCommerceRepository({} as never);

    await expect(
      repository.reserveUsage(
        {
          organisationId: 'org-solo',
          outboundMessageId: 'outbound-changed-parts',
          source: 'MANUAL_REMINDER',
          partCount: 2,
          now
        },
        executor
      )
    ).resolves.toEqual({
      kind: 'blocked',
      reason: 'SMS_ALLOWANCE_EXHAUSTED',
      projectedParts: 3
    });
    expect(insertedUsage).toEqual([]);
  });

  it('blocks a retry when its reservation belongs to a prior billing period', async () => {
    const priorPeriodStart = new Date('2026-10-01T00:00:00.000Z');
    const { executor, insertedUsage } = createExecutor({
      includedParts: 2_000,
      entries: [],
      existingReservation: {
        partDelta: 2,
        billingPeriodStart: priorPeriodStart,
        billingPeriodEnd: periodEnd
      }
    });
    const repository = new PostgresSmsCommerceRepository({} as never);

    await expect(
      repository.reserveUsage(
        {
          organisationId: 'org-solo',
          outboundMessageId: 'outbound-prior-period',
          source: 'MANUAL_REMINDER',
          partCount: 2,
          now
        },
        executor
      )
    ).resolves.toEqual({
      kind: 'blocked',
      reason: 'SMS_ALLOWANCE_EXHAUSTED',
      projectedParts: 2
    });
    expect(insertedUsage).toEqual([]);
  });

  it('blocks a retry when only its persisted billing-period end differs', async () => {
    const stalePeriodEnd = new Date('2026-11-30T00:00:00.000Z');
    const { executor, insertedUsage } = createExecutor({
      includedParts: 2_000,
      entries: [],
      existingReservation: {
        partDelta: 2,
        billingPeriodStart: periodStart,
        billingPeriodEnd: stalePeriodEnd
      }
    });
    const repository = new PostgresSmsCommerceRepository({} as never);

    await expect(
      repository.reserveUsage(
        {
          organisationId: 'org-solo',
          outboundMessageId: 'outbound-stale-period-end',
          source: 'MANUAL_REMINDER',
          partCount: 2,
          now
        },
        executor
      )
    ).resolves.toEqual({
      kind: 'blocked',
      reason: 'SMS_ALLOWANCE_EXHAUSTED',
      projectedParts: 2
    });
    expect(insertedUsage).toEqual([]);
  });

  it('loads the configured allowance independently of a Stripe billing period', async () => {
    const { executor } = createExecutor({
      includedParts: 2_500,
      entries: []
    });
    const repository = new PostgresSmsCommerceRepository({} as never);

    await expect(repository.loadAllowance('org-solo', executor)).resolves.toEqual({
      includedParts: 2_500,
      warningPercent: 80
    });
  });

  it('returns included, used inputs and remaining parts without runtime overage fields', async () => {
    const { executor } = createExecutor({
      includedParts: 2_500,
      entries: [
        { entryType: 'RESERVE', partDelta: 1_200 },
        { entryType: 'COMMIT', partDelta: 1_200 },
        { entryType: 'RESERVE', partDelta: 40 }
      ]
    });
    const repository = new PostgresSmsCommerceRepository({} as never);

    await expect(repository.loadUsage('org-solo', executor)).resolves.toEqual({
      billingPeriodStart: periodStart,
      billingPeriodEnd: periodEnd,
      includedParts: 2_500,
      warningPercent: 80,
      committedParts: 1_200,
      reservedParts: 40,
      remainingParts: 1_260
    });
  });
});
