import { and, eq } from 'drizzle-orm';

import { authorise, type AppSession } from '@bc5000/auth';
import {
  approvals,
  auditEvents,
  contactChannels,
  contacts,
  type Database,
  invoiceChases,
  invoices,
  organisations,
  PostgresOrganisationSafetyRepository,
  PostgresReminderWhitelistRepository,
  reminderSequences,
  reminderSequenceVersions,
  stageInstances,
  suppressions
} from '@bc5000/db/web';
import {
  evaluateProviderSendPolicy,
  renderSms,
  selectPreferredSmsChannel
} from '@bc5000/domain';
import { jobNames, type JobPublisher } from '@bc5000/jobs';

export type ManualReminderOrigin = 'CUSTOMER_PAGE' | 'ESCALATION';

export interface QueueManualReminderInput {
  organisationId: string;
  customerId: string;
  invoiceId: string;
  channel: 'SMS' | 'XERO_EMAIL';
  message?: string;
  confirmed: boolean;
  requestId: string;
  origin: ManualReminderOrigin;
}

export interface ManualReminderServiceDependencies {
  database: Database;
  publisher: JobPublisher;
  clock: { now(): Date };
}

export function createManualReminderService(
  dependencies: ManualReminderServiceDependencies
) {
  const safety = new PostgresOrganisationSafetyRepository(dependencies.database);
  const queue = async (
    session: AppSession,
    input: QueueManualReminderInput
  ) => {
    authorise(session, 'chase.operate', input.organisationId);
    if (!input.confirmed) throw new Error('MANUAL_SEND_CONFIRMATION_REQUIRED');

    const [target] = await dependencies.database
      .select({
        invoice: invoices,
        contact: contacts,
        chase: invoiceChases,
        organisation: organisations,
        sequenceVersionId: reminderSequenceVersions.id,
        maxSmsSegments: reminderSequenceVersions.maxSmsSegments
      })
      .from(invoices)
      .innerJoin(
        contacts,
        and(
          eq(contacts.id, invoices.contactId),
          eq(contacts.organisationId, input.organisationId)
        )
      )
      .innerJoin(
        invoiceChases,
        and(
          eq(invoiceChases.invoiceId, invoices.id),
          eq(invoiceChases.organisationId, input.organisationId),
          eq(invoiceChases.status, 'ACTIVE')
        )
      )
      .innerJoin(
        reminderSequences,
        and(
          eq(reminderSequences.id, invoiceChases.sequenceId),
          eq(reminderSequences.organisationId, input.organisationId),
          eq(reminderSequences.enabled, true)
        )
      )
      .innerJoin(
        reminderSequenceVersions,
        and(
          eq(reminderSequenceVersions.sequenceId, reminderSequences.id),
          eq(reminderSequenceVersions.organisationId, input.organisationId),
          eq(reminderSequenceVersions.status, 'ACTIVE')
        )
      )
      .innerJoin(
        organisations,
        eq(organisations.id, input.organisationId)
      )
      .where(
        and(
          eq(invoices.organisationId, input.organisationId),
          eq(invoices.id, input.invoiceId),
          eq(invoices.contactId, input.customerId)
        )
      )
      .limit(1);
    if (target === undefined) throw new Error('INVOICE_NOT_SENDABLE');
    if (
      target.invoice.type !== 'ACCREC' ||
      target.invoice.status !== 'AUTHORISED' ||
      Number(target.invoice.amountDue) <= 0
    ) {
      throw new Error('INVOICE_NOT_OUTSTANDING');
    }

    const whitelist = new PostgresReminderWhitelistRepository(
      dependencies.database
    );
    const activeWhitelist = await whitelist.findActive({
      organisationId: input.organisationId,
      contactId: input.customerId,
      invoiceId: input.invoiceId
    });
    if (activeWhitelist.length > 0) throw new Error('REMINDER_WHITELISTED');

    let preview: string;
    let destination: string;
    if (input.channel === 'SMS') {
      const message = input.message?.trim() ?? '';
      if (message === '') throw new Error('SMS_MESSAGE_REQUIRED');
      if (
        target.invoice.onlineInvoiceUrl === null ||
        !message.includes(target.invoice.onlineInvoiceUrl)
      ) {
        throw new Error('PAYMENT_LINK_REQUIRED');
      }
      const smsChannels = await dependencies.database
        .select()
        .from(contactChannels)
        .where(
          and(
            eq(contactChannels.organisationId, input.organisationId),
            eq(contactChannels.contactId, input.customerId),
            eq(contactChannels.kind, 'SMS'),
            eq(contactChannels.usable, true)
          )
        );
      const smsChannel = selectPreferredSmsChannel(smsChannels);
      if (smsChannel === undefined) throw new Error('SMS_CHANNEL_UNAVAILABLE');
      destination = smsChannel.normalisedValue;
      preview = renderSms(message, {}, {
        maxSegments: target.maxSmsSegments
      }).content;
    } else {
      if (target.contact.email === null) {
        throw new Error('EMAIL_CHANNEL_UNAVAILABLE');
      }
      destination = target.contact.email.toLocaleLowerCase('en-AU');
      preview = `Xero invoice email for ${target.invoice.invoiceNumber} to ${target.contact.name}`;
    }

    const [suppression] = await dependencies.database
      .select()
      .from(suppressions)
      .where(
        and(
          eq(suppressions.organisationId, input.organisationId),
          eq(suppressions.channel, input.channel),
          eq(suppressions.normalisedDestination, destination),
          eq(suppressions.consentState, 'SUPPRESSED')
        )
      )
      .limit(1);
    if (suppression !== undefined) {
      throw new Error(
        `${input.channel === 'SMS' ? 'SMS' : 'EMAIL'}_SUPPRESSED:${suppression.source}`
      );
    }
    const policy = evaluateProviderSendPolicy({
      sendMode: target.organisation.sendMode,
      liveSendAcknowledged: target.organisation.liveSendAcknowledged,
      rolloutScope: target.organisation.rolloutScope,
      maintenanceMode: target.organisation.maintenanceMode,
      source:
        input.channel === 'XERO_EMAIL'
          ? 'XERO_EMAIL'
          : input.origin === 'ESCALATION'
            ? 'ESCALATION_SMS'
            : 'MANUAL_REMINDER',
      channel: input.channel,
      destination,
      recipientAllowlist: target.organisation.recipientAllowlist
    });
    if (policy.kind === 'blocked') throw new Error(policy.reason);
    if (policy.kind === 'dry-run' && policy.reason === 'LIVE_NOT_ACKNOWLEDGED') {
      throw new Error('LIVE_SEND_NOT_ACKNOWLEDGED');
    }
    if (
      policy.kind === 'dry-run' &&
      policy.reason === 'CONTROLLED_RECIPIENT_NOT_ALLOWLISTED'
    ) {
      throw new Error(
        input.channel === 'SMS'
          ? 'SMS_DESTINATION_NOT_ALLOWLISTED'
          : 'EMAIL_DESTINATION_NOT_ALLOWLISTED'
      );
    }

    const stageOrigin =
      input.origin === 'ESCALATION' ? 'ESCALATION_SMS' : 'MANUAL_REMINDER';
    const stageKey =
      input.origin === 'ESCALATION' ? 'escalation-sms' : 'manual';
    const auditEventType =
      input.origin === 'ESCALATION'
        ? 'ESCALATION_SMS_QUEUED'
        : 'MANUAL_REMINDER_QUEUED';
    const now = dependencies.clock.now();
    await dependencies.database.transaction(async (transaction) => {
      await safety.assertOperationalMutationAllowed(
        transaction,
        input.organisationId
      );
      const created = await transaction
        .insert(stageInstances)
        .values({
          id: input.requestId,
          organisationId: input.organisationId,
          invoiceChaseId: target.chase.id,
          sequenceVersionId: target.sequenceVersionId,
          stageKey,
          origin: stageOrigin,
          createdByUserId: session.userId,
          channel: input.channel,
          status: 'QUEUED',
          scheduledAt: now,
          sourceVersion: target.invoice.syncVersion,
          updatedAt: now
        })
        .onConflictDoNothing()
        .returning({ id: stageInstances.id });
      if (created.length === 0) {
        const [existing] = await transaction
          .select({
            organisationId: stageInstances.organisationId,
            invoiceChaseId: stageInstances.invoiceChaseId,
            stageKey: stageInstances.stageKey,
            origin: stageInstances.origin,
            channel: stageInstances.channel,
            sourceVersion: stageInstances.sourceVersion
          })
          .from(stageInstances)
          .where(eq(stageInstances.id, input.requestId))
          .limit(1);
        if (
          existing === undefined ||
          existing.organisationId !== input.organisationId ||
          existing.invoiceChaseId !== target.chase.id ||
          existing.stageKey !== stageKey ||
          existing.origin !== stageOrigin ||
          existing.channel !== input.channel ||
          existing.sourceVersion !== target.invoice.syncVersion
        ) {
          throw new Error('MANUAL_REQUEST_CONFLICT');
        }
        return;
      }

      await transaction.insert(approvals).values({
        organisationId: input.organisationId,
        stageInstanceId: input.requestId,
        renderedPreview: preview,
        sourceVersion: target.invoice.syncVersion,
        status: 'APPROVED',
        decidedByUserId: session.userId,
        decidedAt: now,
        expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000)
      });
      await transaction.insert(auditEvents).values({
        organisationId: input.organisationId,
        actorUserId: session.userId,
        eventType: auditEventType,
        entityType: 'INVOICE',
        entityId: input.invoiceId,
        afterValue: {
          channel: input.channel,
          stageInstanceId: input.requestId,
          source: stageOrigin
        },
        occurredAt: now
      });
    });

    await dependencies.publisher.publish(
      jobNames.reminderExecute,
      {
        organisationId: input.organisationId,
        stageInstanceId: input.requestId
      },
      {
        singletonKey: `${input.origin === 'ESCALATION' ? 'escalation-sms' : 'manual'}:${input.requestId}`
      }
    );
    return { queued: true, stageInstanceId: input.requestId };
  };

  return { queue };
}
