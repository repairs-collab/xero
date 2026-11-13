export interface SmsOverageStatement {
  id: string;
  organisationId: string;
  billableParts: number;
  unitCents: number;
  subtotalCents: number;
  stripeCustomerId: string;
  stripeSubscriptionId: string;
  stripeInvoiceId: string | null;
  stripeInvoiceItemId: string | null;
}

export interface SmsOverageBillingRepository {
  claimNextDue(now: Date): Promise<SmsOverageStatement | null>;
  recordInvoiceCreated(
    statementId: string,
    stripeInvoiceId: string,
    now: Date
  ): Promise<void>;
  recordInvoiceItemCreated(
    statementId: string,
    stripeInvoiceItemId: string,
    now: Date
  ): Promise<void>;
  markInvoiced(statementId: string, now: Date): Promise<void>;
  markFailed(
    statementId: string,
    errorCode: string,
    now: Date
  ): Promise<void>;
}

export interface SmsOverageInvoiceGateway {
  createSmsOverageInvoice(input: {
    organisationId: string;
    statementId: string;
    stripeCustomerId: string;
    stripeSubscriptionId: string;
    idempotencyKey: string;
  }): Promise<{ id: string }>;
  createSmsOverageInvoiceItem(input: {
    organisationId: string;
    statementId: string;
    stripeCustomerId: string;
    stripeSubscriptionId: string;
    stripeInvoiceId: string;
    billableParts: number;
    idempotencyKey: string;
  }): Promise<{ id: string }>;
  finalizeSmsOverageInvoice(input: {
    stripeInvoiceId: string;
    idempotencyKey: string;
  }): Promise<{ id: string }>;
  retrieveSmsOverageInvoice(
    stripeInvoiceId: string
  ): Promise<{
    id: string;
    status: 'draft' | 'open' | 'paid' | 'void' | 'uncollectible';
  }>;
}

const requireStatement = (statement: SmsOverageStatement): void => {
  if (
    statement.id.trim() === '' ||
    statement.organisationId.trim() === '' ||
    statement.stripeCustomerId.trim() === '' ||
    statement.stripeSubscriptionId.trim() === '' ||
    !Number.isSafeInteger(statement.billableParts) ||
    statement.billableParts < 1 ||
    statement.unitCents !== 11 ||
    statement.subtotalCents !== statement.billableParts * 11
  ) {
    throw new Error('SMS_OVERAGE_STATEMENT_INVALID');
  }
};

const safeErrorCode = (error: unknown): string => {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && /^[A-Z0-9_]{1,64}$/u.test(code)) {
      return code;
    }
  }
  return 'STRIPE_PROVIDER_FAILURE';
};

export const reconcileSmsOverageInvoices = async (dependencies: {
  repository: SmsOverageBillingRepository;
  stripe: SmsOverageInvoiceGateway;
  clock: { now(): Date };
}): Promise<{ invoiced: number }> => {
  let invoiced = 0;
  while (true) {
    const claimedAt = dependencies.clock.now();
    const statement = await dependencies.repository.claimNextDue(claimedAt);
    if (statement === null) return { invoiced };
    requireStatement(statement);

    try {
      let stripeInvoiceId = statement.stripeInvoiceId;
      if (stripeInvoiceId === null) {
        const invoice = await dependencies.stripe.createSmsOverageInvoice({
          organisationId: statement.organisationId,
          statementId: statement.id,
          stripeCustomerId: statement.stripeCustomerId,
          stripeSubscriptionId: statement.stripeSubscriptionId,
          idempotencyKey: `sms-overage:${statement.id}:invoice`
        });
        stripeInvoiceId = invoice.id;
        await dependencies.repository.recordInvoiceCreated(
          statement.id,
          stripeInvoiceId,
          dependencies.clock.now()
        );
      }

      if (statement.stripeInvoiceItemId === null) {
        const item =
          await dependencies.stripe.createSmsOverageInvoiceItem({
            organisationId: statement.organisationId,
            statementId: statement.id,
            stripeCustomerId: statement.stripeCustomerId,
            stripeSubscriptionId: statement.stripeSubscriptionId,
            stripeInvoiceId,
            billableParts: statement.billableParts,
            idempotencyKey: `sms-overage:${statement.id}:item`
          });
        await dependencies.repository.recordInvoiceItemCreated(
          statement.id,
          item.id,
          dependencies.clock.now()
        );
      }

      const recordedInvoiceWasAlreadyComplete =
        statement.stripeInvoiceId !== null &&
        statement.stripeInvoiceItemId !== null;
      const existingInvoice = recordedInvoiceWasAlreadyComplete
        ? await dependencies.stripe.retrieveSmsOverageInvoice(stripeInvoiceId)
        : null;
      if (
        existingInvoice !== null &&
        (existingInvoice.id !== stripeInvoiceId ||
          existingInvoice.status === 'void' ||
          existingInvoice.status === 'uncollectible')
      ) {
        throw new Error('STRIPE_PROVIDER_FAILURE');
      }
      if (existingInvoice === null || existingInvoice.status === 'draft') {
        const finalized =
          await dependencies.stripe.finalizeSmsOverageInvoice({
            stripeInvoiceId,
            idempotencyKey: `sms-overage:${statement.id}:finalize`
          });
        if (finalized.id !== stripeInvoiceId) {
          throw new Error('STRIPE_PROVIDER_FAILURE');
        }
      }
      await dependencies.repository.markInvoiced(
        statement.id,
        dependencies.clock.now()
      );
      invoiced += 1;
    } catch (error) {
      await dependencies.repository.markFailed(
        statement.id,
        safeErrorCode(error),
        dependencies.clock.now()
      );
      throw error;
    }
  }
};
