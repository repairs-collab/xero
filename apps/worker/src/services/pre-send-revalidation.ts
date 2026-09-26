import {
  and,
  desc,
  eq,
  gt,
  isNull,
  or
} from 'drizzle-orm';

import {
  approvals,
  contactChannels,
  contacts,
  disputes,
  type Database,
  invoiceChases,
  invoices,
  organisations,
  pauses,
  paymentPromises,
  reminderSequences,
  sequenceStages,
  stageInstances,
  suppressions
} from '@bc5000/db';
import { evaluateEligibility } from '@bc5000/domain';
import { selectPreferredSmsChannel } from '@bc5000/domain';
import type {
  XeroInvoice,
  XeroResult
} from '@bc5000/integrations/xero';

export interface RevalidationXeroClient {
  getInvoice(invoiceId: string): Promise<XeroResult<XeroInvoice>>;
  getOnlineInvoiceUrl(invoiceId: string): Promise<XeroResult<string>>;
}

export type StopReason =
  | 'NOT_ACCREC'
  | 'NOT_AUTHORISED'
  | 'NO_BALANCE'
  | 'CONTACT_INACTIVE'
  | 'INVOICE_PAUSED'
  | 'CUSTOMER_PAUSED'
  | 'SEQUENCE_PAUSED'
  | 'CHANNEL_UNUSABLE'
  | 'CHANNEL_SUPPRESSED'
  | 'STAGE_COMPLETED'
  | 'DISPUTE_OPEN'
  | 'PROMISE_TO_PAY'
  | 'SOURCE_CHANGED'
  | 'APPROVAL_REQUIRED';

export interface RevalidatedReminder {
  organisationId: string;
  organisationName: string;
  sendMode: 'dry-run' | 'live';
  liveSendAcknowledged: boolean;
  recipientAllowlist: string[];
  stageInstanceId: string;
  stageKey: string;
  channel: 'SMS' | 'XERO_EMAIL';
  sourceVersion: number;
  sequenceMode: 'REVIEW' | 'AUTOMATIC';
  sequenceId: string;
  invoiceId: string;
  xeroInvoiceId: string;
  invoiceNumber: string;
  amountDue: string;
  currency: string;
  dueDate: string;
  onlineInvoiceUrl: string;
  contactId: string;
  customerName: string;
  destination: string;
  content: string;
}

export type RevalidationResult =
  | { kind: 'eligible'; reminder: RevalidatedReminder }
  | { kind: 'blocked'; reason: StopReason };

export interface RevalidationDependencies {
  database: Database;
  xero: RevalidationXeroClient;
  now: Date;
}

const firstEligibilityReason = (
  reasons: ReturnType<typeof evaluateEligibility>['reasons']
): StopReason =>
  reasons.includes('NO_BALANCE')
    ? 'NO_BALANCE'
    : (reasons[0] ?? 'CHANNEL_UNUSABLE');

const promiseStillActive = (
  promisedDate: string,
  graceDays: number,
  now: Date
): boolean => {
  const end = new Date(`${promisedDate}T23:59:59.999Z`);
  end.setUTCDate(end.getUTCDate() + graceDays);
  return end.getTime() >= now.getTime();
};

export async function revalidateReminder(
  dependencies: RevalidationDependencies,
  input: { organisationId: string; stageInstanceId: string }
): Promise<RevalidationResult> {
  const rows = await dependencies.database
    .select({
      organisation: organisations,
      stage: stageInstances,
      chase: invoiceChases,
      invoice: invoices,
      contact: contacts,
      sequence: reminderSequences
    })
    .from(stageInstances)
    .innerJoin(
      invoiceChases,
      and(
        eq(invoiceChases.id, stageInstances.invoiceChaseId),
        eq(invoiceChases.organisationId, input.organisationId)
      )
    )
    .innerJoin(
      invoices,
      and(
        eq(invoices.id, invoiceChases.invoiceId),
        eq(invoices.organisationId, input.organisationId)
      )
    )
    .innerJoin(
      contacts,
      and(
        eq(contacts.id, invoices.contactId),
        eq(contacts.organisationId, input.organisationId)
      )
    )
    .innerJoin(
      reminderSequences,
      and(
        eq(reminderSequences.id, invoiceChases.sequenceId),
        eq(reminderSequences.organisationId, input.organisationId)
      )
    )
    .innerJoin(
      organisations,
      eq(organisations.id, input.organisationId)
    )
    .where(
      and(
        eq(stageInstances.organisationId, input.organisationId),
        eq(stageInstances.id, input.stageInstanceId)
      )
    )
    .limit(1);
  const row = rows[0];
  if (row === undefined) throw new Error('Reminder stage was not found');
  if (row.stage.channel === 'TASK') {
    return { kind: 'blocked', reason: 'CHANNEL_UNUSABLE' };
  }

  let currentStatus = row.invoice.status;
  let currentAmountDue = row.invoice.amountDue;
  let currentSourceVersion = row.invoice.syncVersion;
  const age = dependencies.now.getTime() - row.invoice.updatedAt.getTime();
  if (age > 5 * 60 * 1000) {
    const refreshed = await dependencies.xero.getInvoice(
      row.invoice.xeroInvoiceId
    );
    const changed =
      refreshed.data.status !== row.invoice.status ||
      refreshed.data.amountDue !== row.invoice.amountDue ||
      refreshed.data.dueDate !== row.invoice.dueDate;
    currentStatus = refreshed.data.status;
    currentAmountDue = refreshed.data.amountDue;
    currentSourceVersion += changed ? 1 : 0;
    await dependencies.database
      .update(invoices)
      .set({
        status: refreshed.data.status,
        amountDue: refreshed.data.amountDue,
        dueDate: refreshed.data.dueDate,
        syncVersion: currentSourceVersion,
        xeroUpdatedAt:
          refreshed.data.updatedAt === null
            ? null
            : new Date(refreshed.data.updatedAt),
        updatedAt: dependencies.now
      })
      .where(
        and(
          eq(invoices.organisationId, input.organisationId),
          eq(invoices.id, row.invoice.id)
        )
      );
  }

  const activePauses = await dependencies.database
    .select()
    .from(pauses)
    .where(
      and(
        eq(pauses.organisationId, input.organisationId),
        eq(pauses.active, true),
        or(isNull(pauses.expiresAt), gt(pauses.expiresAt, dependencies.now)),
        or(
          and(
            eq(pauses.scope, 'customer'),
            eq(pauses.contactId, row.contact.id)
          ),
          and(eq(pauses.scope, 'invoice'), eq(pauses.invoiceId, row.invoice.id)),
          and(
            eq(pauses.scope, 'sequence'),
            eq(pauses.sequenceId, row.sequence.id)
          )
        )
      )
    );
  const hasCustomerPause = activePauses.some(
    (pause) => pause.scope === 'customer'
  );
  const hasInvoicePause = activePauses.some(
    (pause) => pause.scope === 'invoice'
  );
  const hasSequencePause = activePauses.some(
    (pause) => pause.scope === 'sequence'
  );

  const [openDispute] = await dependencies.database
    .select({ id: disputes.id })
    .from(disputes)
    .where(
      and(
        eq(disputes.organisationId, input.organisationId),
        eq(disputes.contactId, row.contact.id),
        eq(disputes.status, 'OPEN'),
        or(isNull(disputes.invoiceId), eq(disputes.invoiceId, row.invoice.id))
      )
    )
    .limit(1);
  if (openDispute !== undefined) {
    return { kind: 'blocked', reason: 'DISPUTE_OPEN' };
  }

  const promises = await dependencies.database
    .select()
    .from(paymentPromises)
    .where(
      and(
        eq(paymentPromises.organisationId, input.organisationId),
        eq(paymentPromises.contactId, row.contact.id),
        eq(paymentPromises.status, 'ACTIVE')
      )
    );
  if (
    promises.some((promise) =>
      promiseStillActive(
        promise.promisedDate,
        promise.graceDays,
        dependencies.now
      )
    )
  ) {
    return { kind: 'blocked', reason: 'PROMISE_TO_PAY' };
  }

  const smsChannels =
    row.stage.channel === 'SMS'
      ? await dependencies.database
          .select()
          .from(contactChannels)
          .where(
            and(
              eq(contactChannels.organisationId, input.organisationId),
              eq(contactChannels.contactId, row.contact.id),
              eq(contactChannels.kind, 'SMS'),
              eq(contactChannels.usable, true)
            )
          )
      : [];
  const smsChannel = selectPreferredSmsChannel(smsChannels);
  const destination =
    row.stage.channel === 'SMS' ? smsChannel?.normalisedValue : row.contact.email;
  const [suppression] =
    destination === undefined || destination === null
      ? []
      : await dependencies.database
          .select()
          .from(suppressions)
          .where(
            and(
              eq(suppressions.organisationId, input.organisationId),
              eq(suppressions.channel, row.stage.channel),
              eq(suppressions.normalisedDestination, destination),
              eq(suppressions.consentState, 'SUPPRESSED')
            )
          )
          .limit(1);

  const eligibility = evaluateEligibility({
    type: row.invoice.type,
    status: currentStatus,
    amountDue: currentAmountDue,
    contactActive: row.contact.active,
    invoicePaused: hasInvoicePause,
    customerPaused: hasCustomerPause,
    sequencePaused: hasSequencePause,
    channelUsable: destination !== undefined && destination !== null,
    channelSuppressed: suppression !== undefined,
    stageCompleted: false
  });
  if (!eligibility.eligible) {
    return {
      kind: 'blocked',
      reason: firstEligibilityReason(eligibility.reasons)
    };
  }

  const [approval] = await dependencies.database
    .select()
    .from(approvals)
    .where(
      and(
        eq(approvals.organisationId, input.organisationId),
        eq(approvals.stageInstanceId, input.stageInstanceId)
      )
    )
    .orderBy(desc(approvals.createdAt))
    .limit(1);
  if (row.sequence.mode === 'REVIEW' || row.stage.stageKey === 'manual') {
    if (
      approval === undefined ||
      approval.status !== 'APPROVED' ||
      approval.expiresAt <= dependencies.now
    ) {
      return { kind: 'blocked', reason: 'APPROVAL_REQUIRED' };
    }
    if (
      approval.sourceVersion !== currentSourceVersion ||
      row.stage.sourceVersion !== currentSourceVersion
    ) {
      return { kind: 'blocked', reason: 'SOURCE_CHANGED' };
    }
  }

  let onlineInvoiceUrl = row.invoice.onlineInvoiceUrl ?? '';
  if (row.stage.channel === 'SMS') {
    const online = await dependencies.xero.getOnlineInvoiceUrl(
      row.invoice.xeroInvoiceId
    );
    if (
      approval !== undefined &&
      row.invoice.onlineInvoiceUrl !== null &&
      online.data !== row.invoice.onlineInvoiceUrl
    ) {
      return { kind: 'blocked', reason: 'SOURCE_CHANGED' };
    }
    onlineInvoiceUrl = online.data;
    await dependencies.database
      .update(invoices)
      .set({ onlineInvoiceUrl, updatedAt: dependencies.now })
      .where(eq(invoices.id, row.invoice.id));
  }

  let content = approval?.renderedPreview;
  if (content === undefined) {
    const [configured] = await dependencies.database
      .select({ template: sequenceStages.template })
      .from(sequenceStages)
      .where(
        and(
          eq(sequenceStages.organisationId, input.organisationId),
          eq(sequenceStages.sequenceVersionId, row.stage.sequenceVersionId),
          row.stage.stageKey === 'daily-after-30'
            ? eq(sequenceStages.channel, 'SMS_DAILY')
            : and(
                eq(sequenceStages.stageKey, row.stage.stageKey),
                eq(sequenceStages.channel, row.stage.channel)
              )
        )
      )
      .limit(1);
    content =
      row.stage.channel === 'XERO_EMAIL'
        ? `Xero invoice email for ${row.invoice.invoiceNumber}`
        : configured?.template
            ?.replaceAll('{{customer_name}}', row.contact.name)
            .replaceAll('{{invoice_number}}', row.invoice.invoiceNumber)
            .replaceAll('{{amount_due}}', currentAmountDue)
            .replaceAll('{{currency}}', row.invoice.currency)
            .replaceAll('{{due_date}}', row.invoice.dueDate)
            .replaceAll('{{online_invoice_url}}', onlineInvoiceUrl)
            .replaceAll('{{organisation_name}}', row.organisation.name);
    if (content === undefined) {
      throw new Error('Reminder content could not be rendered');
    }
  }

  return {
    kind: 'eligible',
    reminder: {
      organisationId: input.organisationId,
      organisationName: row.organisation.name,
      sendMode: row.organisation.sendMode,
      liveSendAcknowledged: row.organisation.liveSendAcknowledged,
      recipientAllowlist: row.organisation.recipientAllowlist,
      stageInstanceId: row.stage.id,
      stageKey: row.stage.stageKey,
      channel: row.stage.channel,
      sourceVersion: currentSourceVersion,
      sequenceMode: row.sequence.mode,
      sequenceId: row.sequence.id,
      invoiceId: row.invoice.id,
      xeroInvoiceId: row.invoice.xeroInvoiceId,
      invoiceNumber: row.invoice.invoiceNumber,
      amountDue: currentAmountDue,
      currency: row.invoice.currency,
      dueDate: row.invoice.dueDate,
      onlineInvoiceUrl,
      contactId: row.contact.id,
      customerName: row.contact.name,
      destination: destination ?? '',
      content
    }
  };
}
