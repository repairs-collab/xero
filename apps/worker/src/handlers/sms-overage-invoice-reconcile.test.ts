import { describe, expect, it } from 'vitest';

import {
  reconcileSmsOverageInvoices,
  type SmsOverageBillingRepository,
  type SmsOverageInvoiceGateway,
  type SmsOverageStatement
} from './sms-overage-invoice-reconcile.js';

const now = new Date('2026-12-01T01:00:00.000Z');

const statement = (
  override: Partial<SmsOverageStatement> = {}
): SmsOverageStatement => ({
  id: 'statement-1',
  organisationId: 'org-1',
  billableParts: 37,
  unitCents: 11,
  subtotalCents: 407,
  stripeCustomerId: 'cus-1',
  stripeSubscriptionId: 'sub-1',
  stripeInvoiceId: null,
  stripeInvoiceItemId: null,
  ...override
});

class FakeRepository implements SmsOverageBillingRepository {
  queue: SmsOverageStatement[] = [];
  invoiceRecords: Array<{ statementId: string; stripeInvoiceId: string }> = [];
  itemRecords: Array<{ statementId: string; stripeInvoiceItemId: string }> = [];
  invoiced: string[] = [];
  failed: Array<{ statementId: string; errorCode: string }> = [];

  claimNextDue(): Promise<SmsOverageStatement | null> {
    return Promise.resolve(this.queue.shift() ?? null);
  }

  recordInvoiceCreated(
    statementId: string,
    stripeInvoiceId: string
  ): Promise<void> {
    this.invoiceRecords.push({ statementId, stripeInvoiceId });
    return Promise.resolve();
  }

  recordInvoiceItemCreated(
    statementId: string,
    stripeInvoiceItemId: string
  ): Promise<void> {
    this.itemRecords.push({ statementId, stripeInvoiceItemId });
    return Promise.resolve();
  }

  markInvoiced(statementId: string): Promise<void> {
    this.invoiced.push(statementId);
    return Promise.resolve();
  }

  markFailed(statementId: string, errorCode: string): Promise<void> {
    this.failed.push({ statementId, errorCode });
    return Promise.resolve();
  }
}

class FakeStripe implements SmsOverageInvoiceGateway {
  invoiceCalls: unknown[] = [];
  itemCalls: unknown[] = [];
  finalizeCalls: unknown[] = [];
  retrieveCalls: string[] = [];
  retrievedStatus: 'draft' | 'open' | 'paid' | 'void' | 'uncollectible' =
    'draft';
  failure: Error | null = null;

  createSmsOverageInvoice(input: unknown): Promise<{ id: string }> {
    this.invoiceCalls.push(input);
    if (this.failure) return Promise.reject(this.failure);
    return Promise.resolve({ id: 'in-overage' });
  }

  createSmsOverageInvoiceItem(input: unknown): Promise<{ id: string }> {
    this.itemCalls.push(input);
    if (this.failure) return Promise.reject(this.failure);
    return Promise.resolve({ id: 'ii-overage' });
  }

  finalizeSmsOverageInvoice(input: unknown): Promise<{ id: string }> {
    this.finalizeCalls.push(input);
    if (this.failure) return Promise.reject(this.failure);
    return Promise.resolve({
      id: (input as { stripeInvoiceId: string }).stripeInvoiceId
    });
  }

  retrieveSmsOverageInvoice(stripeInvoiceId: string): Promise<{
    id: string;
    status: 'draft' | 'open' | 'paid' | 'void' | 'uncollectible';
  }> {
    this.retrieveCalls.push(stripeInvoiceId);
    if (this.failure) return Promise.reject(this.failure);
    return Promise.resolve({ id: stripeInvoiceId, status: this.retrievedStatus });
  }
}

describe('SMS overage invoice reconciliation', () => {
  it('creates, prices and finalizes a due statement with stable step keys', async () => {
    const repository = new FakeRepository();
    const stripe = new FakeStripe();
    repository.queue.push(statement());

    await expect(
      reconcileSmsOverageInvoices({
        repository,
        stripe,
        clock: { now: () => now }
      })
    ).resolves.toEqual({ invoiced: 1 });

    expect(stripe.invoiceCalls).toEqual([{
      organisationId: 'org-1',
      statementId: 'statement-1',
      stripeCustomerId: 'cus-1',
      stripeSubscriptionId: 'sub-1',
      idempotencyKey: 'sms-overage:statement-1:invoice'
    }]);
    expect(stripe.itemCalls).toEqual([{
      organisationId: 'org-1',
      statementId: 'statement-1',
      stripeCustomerId: 'cus-1',
      stripeSubscriptionId: 'sub-1',
      stripeInvoiceId: 'in-overage',
      billableParts: 37,
      idempotencyKey: 'sms-overage:statement-1:item'
    }]);
    expect(stripe.finalizeCalls).toEqual([{
      stripeInvoiceId: 'in-overage',
      idempotencyKey: 'sms-overage:statement-1:finalize'
    }]);
    expect(repository.invoiceRecords).toEqual([{
      statementId: 'statement-1',
      stripeInvoiceId: 'in-overage'
    }]);
    expect(repository.itemRecords).toEqual([{
      statementId: 'statement-1',
      stripeInvoiceItemId: 'ii-overage'
    }]);
    expect(repository.invoiced).toEqual(['statement-1']);
  });

  it('resumes after a crash without recreating recorded provider resources', async () => {
    const repository = new FakeRepository();
    const stripe = new FakeStripe();
    repository.queue.push(statement({
      stripeInvoiceId: 'in-existing',
      stripeInvoiceItemId: 'ii-existing'
    }));

    await reconcileSmsOverageInvoices({
      repository,
      stripe,
      clock: { now: () => now }
    });

    expect(stripe.invoiceCalls).toEqual([]);
    expect(stripe.itemCalls).toEqual([]);
    expect(stripe.retrieveCalls).toEqual(['in-existing']);
    expect(stripe.finalizeCalls).toEqual([{
      stripeInvoiceId: 'in-existing',
      idempotencyKey: 'sms-overage:statement-1:finalize'
    }]);
  });

  it('marks an already-finalized retry as invoiced without finalizing twice', async () => {
    const repository = new FakeRepository();
    const stripe = new FakeStripe();
    stripe.retrievedStatus = 'open';
    repository.queue.push(statement({
      stripeInvoiceId: 'in-existing',
      stripeInvoiceItemId: 'ii-existing'
    }));

    await reconcileSmsOverageInvoices({
      repository,
      stripe,
      clock: { now: () => now }
    });

    expect(stripe.retrieveCalls).toEqual(['in-existing']);
    expect(stripe.finalizeCalls).toEqual([]);
    expect(repository.invoiced).toEqual(['statement-1']);
  });

  it('records a safe failure and leaves the job retryable', async () => {
    const repository = new FakeRepository();
    const stripe = new FakeStripe();
    repository.queue.push(statement());
    stripe.failure = Object.assign(new Error('secret provider detail'), {
      code: 'STRIPE_PROVIDER_FAILURE'
    });

    await expect(
      reconcileSmsOverageInvoices({
        repository,
        stripe,
        clock: { now: () => now }
      })
    ).rejects.toThrow('secret provider detail');
    expect(repository.failed).toEqual([{
      statementId: 'statement-1',
      errorCode: 'STRIPE_PROVIDER_FAILURE'
    }]);
    expect(repository.invoiced).toEqual([]);
  });
});
