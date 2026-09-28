import {
  and,
  count,
  eq,
  inArray,
  isNull,
  ne,
  sql
} from 'drizzle-orm';

import {
  approvals,
  auditEvents,
  contactChannels,
  contacts,
  conversationAssignments,
  conversations,
  disputes,
  inboundMessages,
  invoiceChases,
  invoices,
  memberships,
  messageAttempts,
  operationalResetRuns,
  operatorReplies,
  organisations,
  outboundMessages,
  pauses,
  paymentPromises,
  PostgresOrganisationSafetyRepository,
  reminderSequences,
  reminderWhitelistEntries,
  stageInstances,
  tasks,
  users,
  type Database,
  type DbTransaction,
  type OperationalState
} from '@bc5000/db';
import {
  operationalJobNames,
  purgeOrganisationOperationalJobs,
  type OperationalJobPurgeCounts
} from '@bc5000/jobs';

export const OPERATIONAL_RESET_ACKNOWLEDGEMENT =
  'I understand this will permanently reset AccountPulse operational data for this organisation';

const rowCountManifestKeys = [
  'reminder_whitelist_entries',
  'conversation_assignments',
  'inbound_messages',
  'operator_replies',
  'message_attempts',
  'outbound_messages',
  'approvals',
  'stage_instances',
  'invoice_chases',
  'tasks',
  'pauses',
  'disputes',
  'payment_promises',
  'conversations',
  'invoices',
  'contact_channels',
  'contacts',
  'reminder_sequences_reset'
] as const;

export type OperationalResetRowCountManifest = Record<
  (typeof rowCountManifestKeys)[number],
  number
>;

export interface OperationalResetResult {
  rowCountManifest: OperationalResetRowCountManifest;
  jobPurgeManifest: OperationalJobPurgeCounts;
}

export interface OperationalResetDependencies {
  database: Database;
  clock: { now(): Date };
  afterEvidenceRecorded?: (input: {
    organisationId: string;
    resetRunId: string;
    rowCountManifest: OperationalResetRowCountManifest;
  }) => void | Promise<void>;
  afterDelete?: (input: {
    tableName: keyof OperationalResetRowCountManifest;
    deletedCount: number;
  }) => void | Promise<void>;
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const commitPattern = /^[0-9a-f]{7,64}$/i;
const safeReasonPattern = /^[A-Za-z0-9][A-Za-z0-9 .,:;()/_-]*$/;
const activeResetStatuses = [
  'PREPARING',
  'SNAPSHOT_CREATED',
  'RESETTING',
  'FAILED'
] as const;

const assertUuid = (value: string, code: string): void => {
  if (!uuidPattern.test(value)) throw new Error(code);
};

const assertSnapshotIdentifier = (value: string): void => {
  if (
    value.length === 0 ||
    value.length > 255 ||
    !/^[A-Za-z][A-Za-z0-9-]*$/.test(value) ||
    value.endsWith('-') ||
    value.includes('--')
  ) {
    throw new Error('INVALID_SNAPSHOT_IDENTIFIER');
  }
};

const acquireOrganisationLock = async (
  transaction: DbTransaction,
  organisationId: string
): Promise<void> => {
  await transaction.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${organisationId}, 0))`
  );
};

const assertNoCrossOrganisationReferences = async (
  transaction: DbTransaction,
  organisationId: string
): Promise<void> => {
  const mismatches = await transaction.execute<{ relationship: string }>(sql`
    with mismatches as (
      select 'contact_channels.contact_id' as relationship
        from contact_channels child join contacts parent on parent.id = child.contact_id
       where child.organisation_id <> ${organisationId}
         and parent.organisation_id = ${organisationId}
      union all
      select 'invoices.contact_id'
        from invoices child join contacts parent on parent.id = child.contact_id
       where child.organisation_id <> ${organisationId}
         and parent.organisation_id = ${organisationId}
      union all
      select 'reminder_whitelist_entries.contact_id'
        from reminder_whitelist_entries child join contacts parent on parent.id = child.contact_id
       where child.organisation_id <> ${organisationId}
         and parent.organisation_id = ${organisationId}
      union all
      select 'reminder_whitelist_entries.invoice_id'
        from reminder_whitelist_entries child join invoices parent on parent.id = child.invoice_id
       where child.organisation_id <> ${organisationId}
         and parent.organisation_id = ${organisationId}
      union all
      select 'invoice_chases.invoice_id'
        from invoice_chases child join invoices parent on parent.id = child.invoice_id
       where child.organisation_id <> ${organisationId}
         and parent.organisation_id = ${organisationId}
      union all
      select 'invoice_chases.sequence_id'
        from invoice_chases child join reminder_sequences parent on parent.id = child.sequence_id
       where child.organisation_id <> ${organisationId}
         and parent.organisation_id = ${organisationId}
      union all
      select 'invoice_chases.customer_id'
        from invoice_chases child join contacts parent on parent.id = child.customer_id
       where child.organisation_id <> ${organisationId}
         and parent.organisation_id = ${organisationId}
      union all
      select 'stage_instances.invoice_chase_id'
        from stage_instances child join invoice_chases parent on parent.id = child.invoice_chase_id
       where child.organisation_id <> ${organisationId}
         and parent.organisation_id = ${organisationId}
      union all
      select 'stage_instances.sequence_version_id'
        from stage_instances child join reminder_sequence_versions parent on parent.id = child.sequence_version_id
       where child.organisation_id <> ${organisationId}
         and parent.organisation_id = ${organisationId}
      union all
      select 'approvals.stage_instance_id'
        from approvals child join stage_instances parent on parent.id = child.stage_instance_id
       where child.organisation_id <> ${organisationId}
         and parent.organisation_id = ${organisationId}
      union all
      select 'outbound_messages.stage_instance_id'
        from outbound_messages child join stage_instances parent on parent.id = child.stage_instance_id
       where child.organisation_id <> ${organisationId}
         and parent.organisation_id = ${organisationId}
      union all
      select 'outbound_messages.contact_id'
        from outbound_messages child join contacts parent on parent.id = child.contact_id
       where child.organisation_id <> ${organisationId}
         and parent.organisation_id = ${organisationId}
      union all
      select 'outbound_messages.invoice_id'
        from outbound_messages child join invoices parent on parent.id = child.invoice_id
       where child.organisation_id <> ${organisationId}
         and parent.organisation_id = ${organisationId}
      union all
      select 'message_attempts.outbound_message_id'
        from message_attempts child join outbound_messages parent on parent.id = child.outbound_message_id
       where child.organisation_id <> ${organisationId}
         and parent.organisation_id = ${organisationId}
      union all
      select 'conversations.contact_id'
        from conversations child join contacts parent on parent.id = child.contact_id
       where child.organisation_id <> ${organisationId}
         and parent.organisation_id = ${organisationId}
      union all
      select 'inbound_messages.conversation_id'
        from inbound_messages child join conversations parent on parent.id = child.conversation_id
       where child.organisation_id <> ${organisationId}
         and parent.organisation_id = ${organisationId}
      union all
      select 'operator_replies.conversation_id'
        from operator_replies child join conversations parent on parent.id = child.conversation_id
       where child.organisation_id <> ${organisationId}
         and parent.organisation_id = ${organisationId}
      union all
      select 'operator_replies.outbound_message_id'
        from operator_replies child join outbound_messages parent on parent.id = child.outbound_message_id
       where child.organisation_id <> ${organisationId}
         and parent.organisation_id = ${organisationId}
      union all
      select 'pauses.contact_id'
        from pauses child join contacts parent on parent.id = child.contact_id
       where child.organisation_id <> ${organisationId}
         and parent.organisation_id = ${organisationId}
      union all
      select 'pauses.invoice_id'
        from pauses child join invoices parent on parent.id = child.invoice_id
       where child.organisation_id <> ${organisationId}
         and parent.organisation_id = ${organisationId}
      union all
      select 'pauses.sequence_id'
        from pauses child join reminder_sequences parent on parent.id = child.sequence_id
       where child.organisation_id <> ${organisationId}
         and parent.organisation_id = ${organisationId}
      union all
      select 'disputes.contact_id'
        from disputes child join contacts parent on parent.id = child.contact_id
       where child.organisation_id <> ${organisationId}
         and parent.organisation_id = ${organisationId}
      union all
      select 'disputes.invoice_id'
        from disputes child join invoices parent on parent.id = child.invoice_id
       where child.organisation_id <> ${organisationId}
         and parent.organisation_id = ${organisationId}
      union all
      select 'payment_promises.contact_id'
        from payment_promises child join contacts parent on parent.id = child.contact_id
       where child.organisation_id <> ${organisationId}
         and parent.organisation_id = ${organisationId}
      union all
      select 'tasks.contact_id'
        from tasks child join contacts parent on parent.id = child.contact_id
       where child.organisation_id <> ${organisationId}
         and parent.organisation_id = ${organisationId}
      union all
      select 'tasks.invoice_id'
        from tasks child join invoices parent on parent.id = child.invoice_id
       where child.organisation_id <> ${organisationId}
         and parent.organisation_id = ${organisationId}
      union all
      select 'tasks.sequence_id'
        from tasks child join reminder_sequences parent on parent.id = child.sequence_id
       where child.organisation_id <> ${organisationId}
         and parent.organisation_id = ${organisationId}
      union all
      select 'conversation_assignments.conversation_id'
        from conversation_assignments child join conversations parent on parent.id = child.conversation_id
       where child.organisation_id <> ${organisationId}
         and parent.organisation_id = ${organisationId}
    )
    select relationship from mismatches limit 1
  `);
  if (mismatches.rows[0] !== undefined) {
    throw new Error('CROSS_ORGANISATION_REFERENCE');
  }
};

const lockOrganisation = async (
  transaction: DbTransaction,
  organisationId: string
) => {
  const [organisation] = await transaction
    .select()
    .from(organisations)
    .where(eq(organisations.id, organisationId))
    .for('update')
    .limit(1);
  if (organisation === undefined) throw new Error('ORGANISATION_NOT_FOUND');
  return organisation;
};

const lockResetRun = async (
  transaction: DbTransaction,
  organisationId: string,
  resetRunId: string
) => {
  const [run] = await transaction
    .select()
    .from(operationalResetRuns)
    .where(
      and(
        eq(operationalResetRuns.id, resetRunId),
        eq(operationalResetRuns.organisationId, organisationId)
      )
    )
    .for('update')
    .limit(1);
  if (run === undefined) throw new Error('RESET_RUN_NOT_FOUND');
  return run;
};

const requireAdmin = async (
  transaction: DbTransaction,
  organisationId: string,
  adminEmail: string
): Promise<string> => {
  const normalisedEmail = adminEmail.trim();
  if (normalisedEmail.length === 0) throw new Error('ADMIN_REQUIRED');
  const [admin] = await transaction
    .select({ userId: users.id })
    .from(users)
    .innerJoin(
      memberships,
      and(
        eq(memberships.userId, users.id),
        eq(memberships.organisationId, organisationId)
      )
    )
    .where(
      and(
        sql`lower(${users.email}) = lower(${normalisedEmail})`,
        eq(memberships.role, 'ADMIN'),
        isNull(users.disabledAt),
        isNull(memberships.disabledAt)
      )
    )
    .limit(1);
  if (admin === undefined) throw new Error('ADMIN_REQUIRED');
  return admin.userId;
};

const assertControlledLive = (organisation: {
  sendMode: 'dry-run' | 'live';
  rolloutScope: 'CONTROLLED' | 'CUSTOMER';
  liveSendAcknowledged: boolean;
}): void => {
  if (
    organisation.sendMode !== 'live' ||
    organisation.rolloutScope !== 'CONTROLLED' ||
    !organisation.liveSendAcknowledged
  ) {
    throw new Error('CONTROLLED_LIVE_REQUIRED');
  }
};

const parseRowCountManifest = (
  value: Record<string, number>
): OperationalResetRowCountManifest => {
  const parsed = {} as OperationalResetRowCountManifest;
  for (const key of rowCountManifestKeys) {
    const count = value[key];
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) {
      throw new Error('INVALID_RESET_ROW_COUNT_MANIFEST');
    }
    parsed[key] = count;
  }
  return parsed;
};

const parseJobPurgeManifest = (
  value: Record<string, number>
): OperationalJobPurgeCounts => {
  const parsed = {} as OperationalJobPurgeCounts;
  for (const name of operationalJobNames) {
    const count = value[name];
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) {
      throw new Error('INVALID_RESET_JOB_PURGE_MANIFEST');
    }
    parsed[name] = count;
  }
  return parsed;
};

const restorableOperationalStates = new Set<OperationalState>([
  'READY',
  'SYNC_REQUIRED',
  'RECONCILIATION_REQUIRED',
  'RECONCILED'
]);

const collectRowCountManifest = async (
  transaction: DbTransaction,
  organisationId: string
): Promise<OperationalResetRowCountManifest> => {
  const valueOf = async (
    query: PromiseLike<Array<{ value: number }>>
  ): Promise<number> => (await query)[0]?.value ?? 0;
  return {
    reminder_whitelist_entries: await valueOf(
      transaction
        .select({ value: count() })
        .from(reminderWhitelistEntries)
        .where(eq(reminderWhitelistEntries.organisationId, organisationId))
    ),
    conversation_assignments: await valueOf(
      transaction
        .select({ value: count() })
        .from(conversationAssignments)
        .where(eq(conversationAssignments.organisationId, organisationId))
    ),
    inbound_messages: await valueOf(
      transaction
        .select({ value: count() })
        .from(inboundMessages)
        .where(eq(inboundMessages.organisationId, organisationId))
    ),
    operator_replies: await valueOf(
      transaction
        .select({ value: count() })
        .from(operatorReplies)
        .where(eq(operatorReplies.organisationId, organisationId))
    ),
    message_attempts: await valueOf(
      transaction
        .select({ value: count() })
        .from(messageAttempts)
        .where(eq(messageAttempts.organisationId, organisationId))
    ),
    outbound_messages: await valueOf(
      transaction
        .select({ value: count() })
        .from(outboundMessages)
        .where(eq(outboundMessages.organisationId, organisationId))
    ),
    approvals: await valueOf(
      transaction
        .select({ value: count() })
        .from(approvals)
        .where(eq(approvals.organisationId, organisationId))
    ),
    stage_instances: await valueOf(
      transaction
        .select({ value: count() })
        .from(stageInstances)
        .where(eq(stageInstances.organisationId, organisationId))
    ),
    invoice_chases: await valueOf(
      transaction
        .select({ value: count() })
        .from(invoiceChases)
        .where(eq(invoiceChases.organisationId, organisationId))
    ),
    tasks: await valueOf(
      transaction
        .select({ value: count() })
        .from(tasks)
        .where(eq(tasks.organisationId, organisationId))
    ),
    pauses: await valueOf(
      transaction
        .select({ value: count() })
        .from(pauses)
        .where(eq(pauses.organisationId, organisationId))
    ),
    disputes: await valueOf(
      transaction
        .select({ value: count() })
        .from(disputes)
        .where(eq(disputes.organisationId, organisationId))
    ),
    payment_promises: await valueOf(
      transaction
        .select({ value: count() })
        .from(paymentPromises)
        .where(eq(paymentPromises.organisationId, organisationId))
    ),
    conversations: await valueOf(
      transaction
        .select({ value: count() })
        .from(conversations)
        .where(eq(conversations.organisationId, organisationId))
    ),
    invoices: await valueOf(
      transaction
        .select({ value: count() })
        .from(invoices)
        .where(eq(invoices.organisationId, organisationId))
    ),
    contact_channels: await valueOf(
      transaction
        .select({ value: count() })
        .from(contactChannels)
        .where(eq(contactChannels.organisationId, organisationId))
    ),
    contacts: await valueOf(
      transaction
        .select({ value: count() })
        .from(contacts)
        .where(eq(contacts.organisationId, organisationId))
    ),
    reminder_sequences_reset: await valueOf(
      transaction
        .select({ value: count() })
        .from(reminderSequences)
        .where(
          and(
            eq(reminderSequences.organisationId, organisationId),
            ne(reminderSequences.mode, 'REVIEW')
          )
        )
    )
  };
};

const executeDeletes = async (
  transaction: DbTransaction,
  organisationId: string,
  now: Date,
  expectedManifest: OperationalResetRowCountManifest,
  afterDelete: OperationalResetDependencies['afterDelete']
): Promise<OperationalResetRowCountManifest> => {
  const manifest = {} as OperationalResetRowCountManifest;
  const record = async (
    tableName: keyof OperationalResetRowCountManifest,
    mutation: PromiseLike<{ rowCount: number | null }>
  ) => {
    const deletedCount = (await mutation).rowCount ?? 0;
    if (deletedCount !== expectedManifest[tableName]) {
      throw new Error('RESET_ROW_COUNT_CHANGED');
    }
    manifest[tableName] = deletedCount;
    await afterDelete?.({ tableName, deletedCount });
  };

  await record(
    'reminder_whitelist_entries',
    transaction
      .delete(reminderWhitelistEntries)
      .where(eq(reminderWhitelistEntries.organisationId, organisationId))
  );
  await record(
    'conversation_assignments',
    transaction
      .delete(conversationAssignments)
      .where(eq(conversationAssignments.organisationId, organisationId))
  );
  await record(
    'inbound_messages',
    transaction
      .delete(inboundMessages)
      .where(eq(inboundMessages.organisationId, organisationId))
  );
  await record(
    'operator_replies',
    transaction
      .delete(operatorReplies)
      .where(eq(operatorReplies.organisationId, organisationId))
  );
  await record(
    'message_attempts',
    transaction
      .delete(messageAttempts)
      .where(eq(messageAttempts.organisationId, organisationId))
  );
  await record(
    'outbound_messages',
    transaction
      .delete(outboundMessages)
      .where(eq(outboundMessages.organisationId, organisationId))
  );
  await record(
    'approvals',
    transaction
      .delete(approvals)
      .where(eq(approvals.organisationId, organisationId))
  );
  await record(
    'stage_instances',
    transaction
      .delete(stageInstances)
      .where(eq(stageInstances.organisationId, organisationId))
  );
  await record(
    'invoice_chases',
    transaction
      .delete(invoiceChases)
      .where(eq(invoiceChases.organisationId, organisationId))
  );
  await record(
    'tasks',
    transaction.delete(tasks).where(eq(tasks.organisationId, organisationId))
  );
  await record(
    'pauses',
    transaction.delete(pauses).where(eq(pauses.organisationId, organisationId))
  );
  await record(
    'disputes',
    transaction
      .delete(disputes)
      .where(eq(disputes.organisationId, organisationId))
  );
  await record(
    'payment_promises',
    transaction
      .delete(paymentPromises)
      .where(eq(paymentPromises.organisationId, organisationId))
  );
  await record(
    'conversations',
    transaction
      .delete(conversations)
      .where(eq(conversations.organisationId, organisationId))
  );
  await record(
    'invoices',
    transaction
      .delete(invoices)
      .where(eq(invoices.organisationId, organisationId))
  );
  await record(
    'contact_channels',
    transaction
      .delete(contactChannels)
      .where(eq(contactChannels.organisationId, organisationId))
  );
  await record(
    'contacts',
    transaction
      .delete(contacts)
      .where(eq(contacts.organisationId, organisationId))
  );
  await record(
    'reminder_sequences_reset',
    transaction
      .update(reminderSequences)
      .set({ mode: 'REVIEW', updatedAt: now })
      .where(
        and(
          eq(reminderSequences.organisationId, organisationId),
          ne(reminderSequences.mode, 'REVIEW')
        )
      )
  );
  return manifest;
};

export function createOperationalResetService(
  dependencies: OperationalResetDependencies
) {
  const safety = new PostgresOrganisationSafetyRepository(
    dependencies.database
  );

  const prepare = async (input: {
    organisationId: string;
    resetRunId: string;
    deployedCommit: string;
    adminEmail: string;
    acknowledgement: string;
    expectedVersion: number;
  }): Promise<void> => {
    assertUuid(input.organisationId, 'INVALID_ORGANISATION_ID');
    assertUuid(input.resetRunId, 'INVALID_RESET_RUN_ID');
    if (!commitPattern.test(input.deployedCommit)) {
      throw new Error('INVALID_DEPLOYED_COMMIT');
    }
    if (input.acknowledgement !== OPERATIONAL_RESET_ACKNOWLEDGEMENT) {
      throw new Error('ACKNOWLEDGEMENT_MISMATCH');
    }
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) {
      throw new Error('INVALID_EXPECTED_VERSION');
    }
    const now = dependencies.clock.now();

    await dependencies.database.transaction(async (transaction) => {
      await acquireOrganisationLock(transaction, input.organisationId);
      const organisation = await lockOrganisation(
        transaction,
        input.organisationId
      );
      assertControlledLive(organisation);
      if (organisation.maintenanceMode) {
        throw new Error('RESET_ALREADY_ACTIVE');
      }
      const adminUserId = await requireAdmin(
        transaction,
        input.organisationId,
        input.adminEmail
      );
      const [activeReset] = await transaction
        .select({ id: operationalResetRuns.id })
        .from(operationalResetRuns)
        .where(
          and(
            eq(operationalResetRuns.organisationId, input.organisationId),
            inArray(operationalResetRuns.status, activeResetStatuses)
          )
        )
        .limit(1);
      if (activeReset !== undefined) throw new Error('RESET_ALREADY_ACTIVE');
      await safety.compareAndSetOperationalState(transaction, {
        organisationId: input.organisationId,
        expectedState: organisation.operationalState,
        expectedVersion: input.expectedVersion,
        nextState: 'RESET_PREPARING',
        maintenanceMode: true,
        rolloutScope: 'CONTROLLED',
        now
      });
      await transaction.insert(operationalResetRuns).values({
        id: input.resetRunId,
        organisationId: input.organisationId,
        status: 'PREPARING',
        requestedByUserId: adminUserId,
        deployedCommit: input.deployedCommit,
        requestedAt: now,
        preparedAt: now,
        updatedAt: now
      });
      await transaction.insert(auditEvents).values({
        organisationId: input.organisationId,
        actorUserId: adminUserId,
        eventType: 'PRODUCTION_OPERATIONAL_RESET_REQUESTED',
        entityType: 'OPERATIONAL_RESET',
        entityId: input.resetRunId,
        correlationId: input.resetRunId,
        beforeValue: {
          operationalState: organisation.operationalState,
          operationalStateVersion: organisation.operationalStateVersion
        },
        afterValue: {
          operationalState: 'RESET_PREPARING',
          acknowledgementAccepted: true,
          deployedCommit: input.deployedCommit
        },
        occurredAt: now
      });
    });
  };

  const recordExecutionFailure = async (input: {
    organisationId: string;
    resetRunId: string;
    snapshotIdentifier: string;
  }): Promise<void> => {
    const failedAt = dependencies.clock.now();
    await dependencies.database.transaction(async (transaction) => {
      await acquireOrganisationLock(transaction, input.organisationId);
      const organisation = await lockOrganisation(
        transaction,
        input.organisationId
      );
      const run = await lockResetRun(
        transaction,
        input.organisationId,
        input.resetRunId
      );
      if (run.status === 'COMPLETED' || run.status === 'ABORTED') return;
      await transaction
        .update(operationalResetRuns)
        .set({
          status: 'FAILED',
          snapshotIdentifier: input.snapshotIdentifier,
          snapshotCreatedAt: run.snapshotCreatedAt ?? failedAt,
          failureCode: 'RESET_EXECUTION_FAILED',
          updatedAt: failedAt
        })
        .where(eq(operationalResetRuns.id, input.resetRunId));
      await transaction
        .update(organisations)
        .set({
          maintenanceMode: true,
          operationalState: 'RESET_FAILED',
          operationalStateVersion: sql`${organisations.operationalStateVersion} + 1`,
          rolloutScope: 'CONTROLLED',
          updatedAt: failedAt
        })
        .where(eq(organisations.id, input.organisationId));
      await transaction.insert(auditEvents).values({
        organisationId: input.organisationId,
        actorUserId: run.requestedByUserId,
        eventType: 'PRODUCTION_OPERATIONAL_RESET_FAILED',
        entityType: 'OPERATIONAL_RESET',
        entityId: input.resetRunId,
        correlationId: input.resetRunId,
        beforeValue: { operationalState: organisation.operationalState },
        afterValue: {
          operationalState: 'RESET_FAILED',
          failureCode: 'RESET_EXECUTION_FAILED',
          snapshotIdentifier: input.snapshotIdentifier
        },
        occurredAt: failedAt
      });
    });
  };

  const execute = async (input: {
    organisationId: string;
    resetRunId: string;
    snapshotIdentifier: string;
  }): Promise<OperationalResetResult> => {
    assertUuid(input.organisationId, 'INVALID_ORGANISATION_ID');
    assertUuid(input.resetRunId, 'INVALID_RESET_RUN_ID');
    const snapshotIdentifier = input.snapshotIdentifier.trim();
    assertSnapshotIdentifier(snapshotIdentifier);

    const evidence = await dependencies.database.transaction(
      async (transaction) => {
        await acquireOrganisationLock(transaction, input.organisationId);
        const organisation = await lockOrganisation(
          transaction,
          input.organisationId
        );
        const run = await lockResetRun(
          transaction,
          input.organisationId,
          input.resetRunId
        );
        if (run.status === 'COMPLETED') {
          if (run.snapshotIdentifier !== snapshotIdentifier) {
            throw new Error('SNAPSHOT_IDENTIFIER_MISMATCH');
          }
          return {
            completed: {
              rowCountManifest: parseRowCountManifest(run.rowCountManifest),
              jobPurgeManifest: parseJobPurgeManifest(run.jobPurgeManifest)
            }
          } as const;
        }
        if (!['PREPARING', 'SNAPSHOT_CREATED', 'FAILED'].includes(run.status)) {
          throw new Error('RESET_NOT_EXECUTABLE');
        }
        assertControlledLive(organisation);
        if (
          !organisation.maintenanceMode ||
          !['RESET_PREPARING', 'RESET_FAILED'].includes(
            organisation.operationalState
          )
        ) {
          throw new Error('RESET_NOT_PREPARED');
        }
        if (
          run.snapshotIdentifier !== null &&
          run.snapshotIdentifier !== snapshotIdentifier
        ) {
          throw new Error('SNAPSHOT_IDENTIFIER_MISMATCH');
        }
        await assertNoCrossOrganisationReferences(
          transaction,
          input.organisationId
        );
        const rowCountManifest =
          run.status === 'PREPARING'
            ? await collectRowCountManifest(transaction, input.organisationId)
            : parseRowCountManifest(run.rowCountManifest);
        const evidenceAt = dependencies.clock.now();
        await transaction
          .update(operationalResetRuns)
          .set({
            status: 'SNAPSHOT_CREATED',
            snapshotIdentifier,
            snapshotCreatedAt: run.snapshotCreatedAt ?? evidenceAt,
            rowCountManifest,
            failureCode: null,
            updatedAt: evidenceAt
          })
          .where(eq(operationalResetRuns.id, input.resetRunId));
        return { rowCountManifest } as const;
      }
    );
    if ('completed' in evidence) return evidence.completed;
    await dependencies.afterEvidenceRecorded?.({
      organisationId: input.organisationId,
      resetRunId: input.resetRunId,
      rowCountManifest: evidence.rowCountManifest
    });

    try {
      return await dependencies.database.transaction(async (transaction) => {
        await acquireOrganisationLock(transaction, input.organisationId);
        const organisation = await lockOrganisation(
          transaction,
          input.organisationId
        );
        const run = await lockResetRun(
          transaction,
          input.organisationId,
          input.resetRunId
        );
        if (run.status === 'COMPLETED') {
          if (run.snapshotIdentifier !== snapshotIdentifier) {
            throw new Error('SNAPSHOT_IDENTIFIER_MISMATCH');
          }
          return {
            rowCountManifest: parseRowCountManifest(run.rowCountManifest),
            jobPurgeManifest: parseJobPurgeManifest(run.jobPurgeManifest)
          };
        }
        if (run.status !== 'SNAPSHOT_CREATED') {
          throw new Error('RESET_NOT_EXECUTABLE');
        }
        if (run.snapshotIdentifier !== snapshotIdentifier) {
          throw new Error('SNAPSHOT_IDENTIFIER_MISMATCH');
        }
        assertControlledLive(organisation);
        if (
          !organisation.maintenanceMode ||
          !['RESET_PREPARING', 'RESET_FAILED'].includes(
            organisation.operationalState
          )
        ) {
          throw new Error('RESET_NOT_PREPARED');
        }
        await assertNoCrossOrganisationReferences(
          transaction,
          input.organisationId
        );

        const startedAt = dependencies.clock.now();
        await transaction
          .update(operationalResetRuns)
          .set({
            status: 'RESETTING',
            failureCode: null,
            updatedAt: startedAt
          })
          .where(eq(operationalResetRuns.id, input.resetRunId));
        await transaction
          .update(organisations)
          .set({
            operationalState: 'RESET_IN_PROGRESS',
            operationalStateVersion: sql`${organisations.operationalStateVersion} + 1`,
            updatedAt: startedAt
          })
          .where(eq(organisations.id, input.organisationId));

        const jobPurgeManifest = await purgeOrganisationOperationalJobs(
          transaction,
          { organisationId: input.organisationId }
        );
        const rowCountManifest = await executeDeletes(
          transaction,
          input.organisationId,
          startedAt,
          evidence.rowCountManifest,
          dependencies.afterDelete
        );
        const completedAt = dependencies.clock.now();
        await transaction
          .update(organisations)
          .set({
            sendMode: 'live',
            rolloutScope: 'CONTROLLED',
            maintenanceMode: false,
            operationalState: 'SYNC_REQUIRED',
            operationalStateVersion: sql`${organisations.operationalStateVersion} + 1`,
            xeroSyncCursor: null,
            lastSuccessfulSyncAt: null,
            latestReconciledSyncAt: null,
            updatedAt: completedAt
          })
          .where(eq(organisations.id, input.organisationId));
        await transaction
          .update(operationalResetRuns)
          .set({
            status: 'COMPLETED',
            snapshotIdentifier,
            rowCountManifest,
            jobPurgeManifest,
            failureCode: null,
            completedAt,
            updatedAt: completedAt
          })
          .where(eq(operationalResetRuns.id, input.resetRunId));
        await transaction.insert(auditEvents).values({
          organisationId: input.organisationId,
          actorUserId: run.requestedByUserId,
          eventType: 'PRODUCTION_OPERATIONAL_DATA_RESET',
          entityType: 'OPERATIONAL_RESET',
          entityId: input.resetRunId,
          correlationId: input.resetRunId,
          beforeValue: {
            operationalState: organisation.operationalState,
            operationalStateVersion: organisation.operationalStateVersion
          },
          afterValue: {
            operationalState: 'SYNC_REQUIRED',
            snapshotIdentifier,
            rowCountManifest,
            jobPurgeManifest
          },
          occurredAt: completedAt
        });
        return { rowCountManifest, jobPurgeManifest };
      });
    } catch (error) {
      await recordExecutionFailure({
        organisationId: input.organisationId,
        resetRunId: input.resetRunId,
        snapshotIdentifier
      });
      throw error;
    }
  };

  const abort = async (input: {
    organisationId: string;
    resetRunId: string;
    adminEmail: string;
    reason: string;
  }): Promise<void> => {
    assertUuid(input.organisationId, 'INVALID_ORGANISATION_ID');
    assertUuid(input.resetRunId, 'INVALID_RESET_RUN_ID');
    const reason = input.reason.trim();
    if (reason.length === 0) {
      throw new Error('ABORT_REASON_REQUIRED');
    }
    if (reason.length > 160 || !safeReasonPattern.test(reason)) {
      throw new Error('INVALID_ABORT_REASON');
    }
    const now = dependencies.clock.now();
    await dependencies.database.transaction(async (transaction) => {
      await acquireOrganisationLock(transaction, input.organisationId);
      const organisation = await lockOrganisation(
        transaction,
        input.organisationId
      );
      const run = await lockResetRun(
        transaction,
        input.organisationId,
        input.resetRunId
      );
      const adminUserId = await requireAdmin(
        transaction,
        input.organisationId,
        input.adminEmail
      );
      if (run.status === 'ABORTED') return;
      if (!['PREPARING', 'SNAPSHOT_CREATED', 'FAILED'].includes(run.status)) {
        throw new Error('RESET_NOT_ABORTABLE');
      }
      const [requestAudit] = await transaction
        .select({ beforeValue: auditEvents.beforeValue })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.organisationId, input.organisationId),
            eq(auditEvents.eventType, 'PRODUCTION_OPERATIONAL_RESET_REQUESTED'),
            eq(auditEvents.entityId, input.resetRunId)
          )
        )
        .limit(1);
      const previousState = requestAudit?.beforeValue?.operationalState;
      const restoredState =
        typeof previousState === 'string' &&
        restorableOperationalStates.has(previousState as OperationalState)
          ? (previousState as OperationalState)
          : 'READY';
      await transaction
        .update(operationalResetRuns)
        .set({
          status: 'ABORTED',
          failureCode: 'ABORTED_BY_ADMIN',
          updatedAt: now
        })
        .where(eq(operationalResetRuns.id, input.resetRunId));
      await transaction
        .update(organisations)
        .set({
          maintenanceMode: false,
          operationalState: restoredState,
          operationalStateVersion: sql`${organisations.operationalStateVersion} + 1`,
          rolloutScope: 'CONTROLLED',
          updatedAt: now
        })
        .where(eq(organisations.id, input.organisationId));
      await transaction.insert(auditEvents).values({
        organisationId: input.organisationId,
        actorUserId: adminUserId,
        eventType: 'PRODUCTION_OPERATIONAL_RESET_ABORTED',
        entityType: 'OPERATIONAL_RESET',
        entityId: input.resetRunId,
        correlationId: input.resetRunId,
        beforeValue: {
          operationalState: organisation.operationalState,
          resetStatus: run.status
        },
        afterValue: {
          operationalState: restoredState,
          resetStatus: 'ABORTED',
          reason
        },
        occurredAt: now
      });
    });
  };

  return { prepare, execute, abort };
}
