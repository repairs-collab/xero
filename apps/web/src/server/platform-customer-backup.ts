import { sql } from 'drizzle-orm';

import { AuthorizationFailure } from '@bc5000/auth';
import {
  type Database,
  platformAdminAuditEvents
} from '@bc5000/db/web';

const tenantTables = [
  'organisation_onboarding',
  'subscriptions',
  'subscription_events',
  'retention_cases',
  'data_request_cases',
  'retention_operation_receipts',
  'sms_number_pool',
  'sms_allowance_settings',
  'sms_usage_ledger',
  'provider_connections',
  'xero_connections',
  'contacts',
  'contact_channels',
  'invoices',
  'reminder_sequences',
  'reminder_sequence_versions',
  'sequence_stages',
  'sequence_exclusions',
  'invoice_chases',
  'stage_instances',
  'approvals',
  'reminder_whitelist_entries',
  'outbound_messages',
  'message_attempts',
  'conversations',
  'inbound_messages',
  'suppressions',
  'operator_replies',
  'pauses',
  'disputes',
  'payment_promises',
  'tasks',
  'webhook_events',
  'audit_events',
  'conversation_assignments',
  'operational_reset_runs',
  'rollout_reconciliations',
  'organisation_voice_settings',
  'voice_call_requests',
  'voice_call_invoices',
  'voice_call_events',
  'voice_gateway_sessions'
] as const;

const forbiddenKey =
  /(password|secret|token|otp|cognito|provider_payload|signature|webhook_key|authorization|ciphertext|refresh_lease|command_hash|content_hash|body_hash)/i;

export const redactCustomerBackup = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(redactCustomerBackup);
  if (value instanceof Date) return value.toISOString();
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).flatMap(([key, entry]) =>
      forbiddenKey.test(key)
        ? []
        : [[key, redactCustomerBackup(entry)] as const]
    )
  );
};

const rows = (result: unknown): Record<string, unknown>[] => {
  if (
    result !== null &&
    typeof result === 'object' &&
    'rows' in result &&
    Array.isArray(result.rows)
  ) {
    return result.rows as Record<string, unknown>[];
  }
  return [];
};

export const createPlatformCustomerBackupService = (dependencies: {
  verifyOwner(userId: string): Promise<boolean>;
  database: Database;
  clock: { now(): Date };
}) => ({
  async createBackup(
    actorUserId: string,
    organisationId: string,
    context: { requestId?: string } = {}
  ) {
    if (!(await dependencies.verifyOwner(actorUserId))) {
      throw new AuthorizationFailure();
    }
    const organisation = rows(
      await dependencies.database.execute(
        sql`select * from organisations where id = ${organisationId} limit 1`
      )
    )[0];
    if (organisation === undefined) throw new Error('ORGANISATION_NOT_FOUND');
    const requestId = context.requestId;
    if (requestId !== undefined) {
      const request = rows(
        await dependencies.database.execute(sql`
          select id, request_type
            from data_request_cases
           where organisation_id = ${organisationId}
             and id = ${requestId}
             and request_type = 'EXPORT'
           limit 1
        `)
      )[0];
      if (request === undefined) throw new Error('DATA_REQUEST_NOT_FOUND');
    }

    const members = rows(
      await dependencies.database.execute(sql`
        select u.id, u.email, u.display_name, u.disabled_at, u.created_at,
               m.role, m.version, m.disabled_at as membership_disabled_at,
               m.created_at as membership_created_at
          from users u
          join memberships m on m.user_id = u.id
         where m.organisation_id = ${organisationId}
         order by u.email
      `)
    );
    const legalAcceptances = rows(
      await dependencies.database.execute(sql`
        select a.user_id, a.terms_version, a.privacy_version,
               a.acceptable_use_version, a.accepted_at
          from user_legal_acceptances a
          join memberships m on m.user_id = a.user_id
         where m.organisation_id = ${organisationId}
         order by a.accepted_at
      `)
    );
    const data: Record<string, unknown> = {};
    for (const table of tenantTables) {
      data[table] = rows(
        await dependencies.database.execute(
          sql`select * from ${sql.identifier(table)} where organisation_id = ${organisationId}`
        )
      );
    }
    const generatedAt = dependencies.clock.now();
    await dependencies.database.insert(platformAdminAuditEvents).values({
      actorUserId,
      targetOrganisationId: organisationId,
      eventType: 'PLATFORM_CUSTOMER_BACKUP_DOWNLOADED',
      entityType: requestId === undefined ? 'ORGANISATION' : 'DATA_REQUEST',
      entityId: requestId ?? organisationId,
      reason:
        requestId === undefined
          ? 'Owner requested customer backup export'
          : 'Owner delivered verified customer export',
      beforeValue: null,
      afterValue: {
        format: 'ACCOUNT_PULSE_JSON_V1',
        generatedAt: generatedAt.toISOString(),
        ...(requestId === undefined ? {} : { requestId })
      },
      occurredAt: generatedAt
    });
    return redactCustomerBackup({
      format: 'ACCOUNT_PULSE_JSON_V1',
      generatedAt,
      notice:
        'Operational customer data export. Authentication credentials, provider secrets, tokens, OTP material and raw provider payloads are intentionally excluded.',
      organisation,
      members,
      legalAcceptances,
      data
    });
  }
});
