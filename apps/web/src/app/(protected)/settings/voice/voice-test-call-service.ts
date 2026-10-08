import { createHash } from 'node:crypto';

import { and, eq, sql } from 'drizzle-orm';
import { parsePhoneNumberFromString } from 'libphonenumber-js';

import { authorise, type AppSession } from '@bc5000/auth';
import {
  auditEvents,
  contacts,
  invoices,
  organisations,
  organisationVoiceSettings,
  voiceCallRequests,
  type Database,
  type PostgresVoiceCallRepository
} from '@bc5000/db/web';
import {
  evaluateVoiceContactPolicy,
  fixedVoiceCallCopy,
  normaliseVoiceAmount
} from '@bc5000/domain';
import { jobNames, type JobPublisher } from '@bc5000/jobs';

import {
  readVoiceSettingsView,
  voiceCallFlowHash
} from './voice-settings.js';

export { voiceCallFlowHash } from './voice-settings.js';

const validVoiceTypes = new Set([
  'FIXED_LINE',
  'MOBILE',
  'FIXED_LINE_OR_MOBILE',
  'VOIP'
]);

const normaliseTestNumber = (value: string): string | null => {
  const parsed = parsePhoneNumberFromString(value, 'AU');
  if (parsed === undefined || !parsed.isValid()) return null;
  const type = parsed.getType();
  return type === undefined || validVoiceTypes.has(type) ? parsed.number : null;
};

const factsHash = (call: {
  purpose: 'CUSTOMER' | 'TEST';
  destinationNumber: string;
  outboundNumber: string;
  combinedAmount: string;
  currency: string;
  agentId: string;
  agentVersion: number;
  voiceId: string;
  voiceSettingsUpdatedAt: Date;
  transferTargetLabel: string;
  invoices: readonly {
    invoiceId: string;
    xeroInvoiceId: string;
    invoiceNumber: string;
    amountDue: string;
    currency: string;
    dueDate: string;
    syncVersion: number;
  }[];
}): string =>
  `sha256:${createHash('sha256')
    .update(
      JSON.stringify({
        purpose: call.purpose,
        destinationNumber: call.destinationNumber,
        outboundNumber: call.outboundNumber,
        combinedAmount: normaliseVoiceAmount(call.combinedAmount),
        currency: call.currency,
        agentId: call.agentId,
        agentVersion: call.agentVersion,
        voiceId: call.voiceId,
        voiceSettingsUpdatedAt: call.voiceSettingsUpdatedAt.toISOString(),
        transferTargetLabel: call.transferTargetLabel,
        callFlowVersion: fixedVoiceCallCopy.version,
        callFlowHash: voiceCallFlowHash,
        invoices: [...call.invoices]
          .sort(
            (left, right) =>
              left.dueDate.localeCompare(right.dueDate) ||
              left.invoiceNumber.localeCompare(right.invoiceNumber)
          )
          .map((invoice) => ({
            ...invoice,
            amountDue: normaliseVoiceAmount(invoice.amountDue)
          }))
      })
    )
    .digest('hex')}`;

export interface VoiceTestCallView {
  purpose: 'TEST';
  voiceCallId: string;
  idempotencyKey: string;
  invoiceNumber: string;
  customerName: string;
  destinationNumber: string;
  amountDue: string;
  currency: string;
  dueDate: string;
  ready: true;
}

export interface VoiceTestCallServiceDependencies {
  database: Database;
  repository: PostgresVoiceCallRepository;
  publisher: JobPublisher;
  session: AppSession;
  clock: { now(): Date };
  holidays: { list(organisationId: string): readonly string[] };
}

const positiveAmount = (value: string): boolean => {
  try {
    return Number(normaliseVoiceAmount(value)) > 0;
  } catch {
    return false;
  }
};

export function createVoiceTestCallService(
  dependencies: VoiceTestCallServiceDependencies
) {
  const authoriseAdmin = (organisationId: string): void => {
    authorise(
      dependencies.session,
      'voice-settings.manage',
      organisationId
    );
  };

  const loadSourceInvoice = async (
    organisationId: string,
    invoiceNumber: string
  ) => {
    const rows = await dependencies.database
      .select({ invoice: invoices, contact: contacts })
      .from(invoices)
      .innerJoin(
        contacts,
        and(
          eq(contacts.organisationId, organisationId),
          eq(contacts.id, invoices.contactId)
        )
      )
      .where(
        and(
          eq(invoices.organisationId, organisationId),
          sql`lower(${invoices.invoiceNumber}) = lower(${invoiceNumber.trim()})`
        )
      )
      .limit(2);
    const row = rows[0];
    if (row === undefined || rows.length !== 1) {
      throw new Error('VOICE_TEST_INVOICE_NOT_FOUND');
    }
    if (
      row.invoice.type !== 'ACCREC' ||
      row.invoice.status !== 'AUTHORISED' ||
      !positiveAmount(row.invoice.amountDue)
    ) {
      throw new Error('VOICE_TEST_INVOICE_NOT_ELIGIBLE');
    }
    return row;
  };

  const loadReadySettings = async (organisationId: string, now: Date) => {
    const [settings, organisation, view] = await Promise.all([
      dependencies.database
        .select()
        .from(organisationVoiceSettings)
        .where(eq(organisationVoiceSettings.organisationId, organisationId))
        .limit(1)
        .then((rows) => rows[0]),
      dependencies.database
        .select()
        .from(organisations)
        .where(eq(organisations.id, organisationId))
        .limit(1)
        .then((rows) => rows[0]),
      readVoiceSettingsView(dependencies.database, organisationId, now)
    ]);
    if (
      settings === undefined ||
      organisation === undefined ||
      !view.connectionReady ||
      !view.genericFlowReady
    ) {
      throw new Error('VOICE_TEST_PROVIDER_NOT_READY');
    }
    const inFlight = await dependencies.database
      .select({ id: voiceCallRequests.id })
      .from(voiceCallRequests)
      .where(
        and(
          eq(voiceCallRequests.organisationId, organisationId),
          sql`${voiceCallRequests.state} in ('SUBMITTING', 'ACCEPTED', 'IN_PROGRESS', 'UNKNOWN')`
        )
      )
      .limit(1);
    const policy = evaluateVoiceContactPolicy({
      now,
      timezone: settings.timezone,
      holidays: [...dependencies.holidays.list(organisationId)],
      weekdayStartLocal: settings.weekdayStartLocal.slice(0, 5),
      weekdayEndLocal: settings.weekdayEndLocal.slice(0, 5),
      featureEnabled: true,
      permissionAllowed: true,
      destinationValid: true,
      voiceSuppressed: false,
      disputeOpen: false,
      promiseToPayActive: false,
      paused: false,
      whitelisted: false,
      staleAccountData:
        organisation.maintenanceMode ||
        !['READY', 'RECONCILED'].includes(organisation.operationalState) ||
        organisation.lastSuccessfulSyncAt === null,
      organisationCallInFlight: inFlight.length > 0,
      attempts: [],
      includedInvoiceIds: ['test-invoice'],
      excludedInvoices: []
    });
    if (!policy.allowed) {
      throw new Error(policy.blockCode ?? 'VOICE_TEST_NOT_ALLOWED');
    }
    return settings;
  };

  const toView = async (
    organisationId: string,
    call: NonNullable<
      Awaited<ReturnType<PostgresVoiceCallRepository['loadForExecution']>>
    >
  ): Promise<VoiceTestCallView> => {
    if (call.purpose !== 'TEST' || call.invoices.length !== 1) {
      throw new Error('VOICE_TEST_CALL_NOT_FOUND');
    }
    const [contact] = await dependencies.database
      .select({ name: contacts.name })
      .from(contacts)
      .where(
        and(
          eq(contacts.organisationId, organisationId),
          eq(contacts.id, call.contactId)
        )
      )
      .limit(1);
    if (contact === undefined) throw new Error('VOICE_TEST_CALL_NOT_FOUND');
    const invoice = call.invoices[0];
    if (invoice === undefined) throw new Error('VOICE_TEST_CALL_NOT_FOUND');
    return {
      purpose: 'TEST',
      voiceCallId: call.id,
      idempotencyKey: call.idempotencyKey,
      invoiceNumber: invoice.invoiceNumber,
      customerName: contact.name,
      destinationNumber: call.destinationNumber,
      amountDue: normaliseVoiceAmount(invoice.amountDue),
      currency: invoice.currency,
      dueDate: invoice.dueDate,
      ready: true
    };
  };

  const prepare = async (input: {
    organisationId: string;
    invoiceNumber: string;
    testNumber: string;
    idempotencyKey: string;
  }): Promise<VoiceTestCallView> => {
    authoriseAdmin(input.organisationId);
    if (input.idempotencyKey.trim() === '') {
      throw new Error('VOICE_TEST_IDEMPOTENCY_KEY_REQUIRED');
    }
    const destinationNumber = normaliseTestNumber(input.testNumber);
    if (destinationNumber === null) {
      throw new Error('VOICE_TEST_NUMBER_INVALID');
    }
    const now = dependencies.clock.now();
    const [source, settings] = await Promise.all([
      loadSourceInvoice(input.organisationId, input.invoiceNumber),
      loadReadySettings(input.organisationId, now)
    ]);
    const [existing] = await dependencies.database
      .select({ id: voiceCallRequests.id })
      .from(voiceCallRequests)
      .where(
        and(
          eq(voiceCallRequests.organisationId, input.organisationId),
          eq(voiceCallRequests.idempotencyKey, input.idempotencyKey),
          eq(voiceCallRequests.purpose, 'TEST')
        )
      )
      .limit(1);
    if (existing !== undefined) {
      const aggregate = await dependencies.repository.loadForExecution(
        input.organisationId,
        existing.id
      );
      if (aggregate === null) throw new Error('VOICE_TEST_CALL_NOT_FOUND');
      return toView(input.organisationId, aggregate);
    }
    const amountDue = normaliseVoiceAmount(source.invoice.amountDue);
    const created = await dependencies.repository.createDraft({
      organisationId: input.organisationId,
      contactId: source.contact.id,
      actorUserId: dependencies.session.userId,
      purpose: 'TEST',
      destinationNumber,
      outboundNumber: settings.outboundNumber,
      combinedAmount: amountDue,
      currency: source.invoice.currency,
      agentId: settings.agentId,
      agentVersion: settings.agentVersion,
      voiceId: settings.voiceId,
      voiceSettingsUpdatedAt: settings.updatedAt,
      transferTargetLabel: settings.officeDestinationLabel,
      idempotencyKey: input.idempotencyKey,
      invoices: [
        {
          invoiceId: source.invoice.id,
          xeroInvoiceId: source.invoice.xeroInvoiceId,
          invoiceNumber: source.invoice.invoiceNumber,
          amountDue,
          currency: source.invoice.currency,
          dueDate: source.invoice.dueDate,
          syncVersion: source.invoice.syncVersion,
          snapshotAt: now
        }
      ],
      now
    });
    return toView(input.organisationId, created);
  };

  const getDraft = async (
    organisationId: string,
    voiceCallId: string
  ): Promise<VoiceTestCallView> => {
    authoriseAdmin(organisationId);
    const call = await dependencies.repository.loadForExecution(
      organisationId,
      voiceCallId
    );
    if (
      call === null ||
      call.purpose !== 'TEST' ||
      call.actorUserId !== dependencies.session.userId ||
      call.state !== 'DRAFT'
    ) {
      throw new Error('VOICE_TEST_CALL_NOT_FOUND');
    }
    return toView(organisationId, call);
  };

  const approveAndQueue = async (input: {
    organisationId: string;
    voiceCallId: string;
    idempotencyKey: string;
    confirmed: boolean;
  }): Promise<{ voiceCallId: string; queued: boolean }> => {
    authoriseAdmin(input.organisationId);
    if (!input.confirmed) throw new Error('VOICE_TEST_CONFIRMATION_REQUIRED');
    const now = dependencies.clock.now();
    const call = await dependencies.repository.loadForExecution(
      input.organisationId,
      input.voiceCallId
    );
    if (
      call === null ||
      call.purpose !== 'TEST' ||
      call.actorUserId !== dependencies.session.userId ||
      call.idempotencyKey !== input.idempotencyKey
    ) {
      throw new Error('VOICE_TEST_CALL_NOT_FOUND');
    }
    const [settings, source] = await Promise.all([
      loadReadySettings(input.organisationId, now),
      loadSourceInvoice(input.organisationId, call.invoices[0]?.invoiceNumber ?? '')
    ]);
    const snapshot = call.invoices[0];
    if (
      snapshot === undefined ||
      call.invoices.length !== 1 ||
      source.invoice.id !== snapshot.invoiceId ||
      source.invoice.xeroInvoiceId !== snapshot.xeroInvoiceId ||
      normaliseVoiceAmount(source.invoice.amountDue) !==
        normaliseVoiceAmount(snapshot.amountDue) ||
      source.invoice.syncVersion !== snapshot.syncVersion ||
      source.invoice.dueDate !== snapshot.dueDate ||
      settings.agentId !== call.agentId ||
      settings.agentVersion !== call.agentVersion ||
      settings.voiceId !== call.voiceId ||
      settings.outboundNumber !== call.outboundNumber ||
      settings.updatedAt.getTime() !== call.voiceSettingsUpdatedAt.getTime()
    ) {
      throw new Error('STALE_ACCOUNT_DATA');
    }
    const approvedFactsHash = factsHash(call);
    const approved = await dependencies.repository.approveAndQueue({
      organisationId: input.organisationId,
      voiceCallId: input.voiceCallId,
      actorUserId: dependencies.session.userId,
      idempotencyKey: input.idempotencyKey,
      callFlowVersion: fixedVoiceCallCopy.version,
      callFlowHash: voiceCallFlowHash,
      approvedFactsHash,
      now
    });
    if (approved.created) {
      await dependencies.database.insert(auditEvents).values({
        organisationId: input.organisationId,
        actorUserId: dependencies.session.userId,
        eventType: 'VOICE_TEST_CALL_FACTS_APPROVED',
        entityType: 'VOICE_CALL',
        entityId: input.voiceCallId,
        correlationId: input.idempotencyKey,
        afterValue: {
          state: 'QUEUED',
          purpose: 'TEST',
          invoiceCount: 1,
          callFlowVersion: fixedVoiceCallCopy.version
        },
        occurredAt: now
      });
    }
    await dependencies.publisher.publish(
      jobNames.voiceCallExecute,
      {
        organisationId: input.organisationId,
        voiceCallId: input.voiceCallId
      },
      { singletonKey: `voice-call:${input.voiceCallId}` }
    );
    return { voiceCallId: input.voiceCallId, queued: approved.created };
  };

  return { prepare, getDraft, approveAndQueue };
}
