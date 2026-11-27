import { createHash, randomUUID } from 'node:crypto';
import { and, asc, eq, exists, gt, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import type { Database, DbTransaction } from '../connection.js';
import {
  lifecycleEmailOutbox as outbox, memberships, users,
  type LifecycleEmailRenderData, type LifecycleEmailTemplate
} from '../schema/index.js';

export interface EnqueueLifecycleEmailInput {
  organisationId: string;
  recipient: string;
  template: LifecycleEmailTemplate;
  templateVersion: number;
  renderData: LifecycleEmailRenderData;
  idempotencyKey: string;
  sourceType: string;
  sourceId: string;
  availableAt: Date;
  expiresAt: Date;
}

export type ClaimedLifecycleEmail = typeof outbox.$inferSelect & {
  status: 'SENDING';
  claimToken: string;
};

interface ClaimIdentity {
  id: string;
  claimToken: string;
}

interface ClaimResultInput extends ClaimIdentity {
  now: Date;
}

type DeliverySuppression = 'RECIPIENT_ACCESS_REVOKED' | 'NOTICE_CANCELLED_BEFORE_SUBMISSION';
type RecipientDeliveryStatus = 'READY' | 'CLAIM_LOST' | DeliverySuppression;

type FailureInput = ClaimResultInput & { failureCode: string };
type EmailDatabase = Database | DbTransaction;

const versionOneRenderFields: Record<LifecycleEmailTemplate, readonly string[]> = {
  WORKSPACE_WELCOME: ['organisationName'],
  ONBOARDING_COMPLETED: ['organisationName'],
  PAYMENT_CONFIRMED: ['organisationName', 'billingCadence'],
  SMS_USAGE_WARNING: ['organisationName', 'committedParts', 'includedParts', 'warningPercent', 'billingPeriodEnd'],
  PAYMENT_FAILED: ['organisationName', 'amountMinor', 'currency', 'recoveryEndsAt'],
  PAYMENT_RECOVERED: ['organisationName'],
  CANCELLATION_SCHEDULED: ['organisationName', 'effectiveAt'],
  CANCELLATION_EFFECTIVE: ['organisationName', 'cancelledAt', 'dataRetainedUntil'],
  EXPORT_DELIVERED: ['organisationName', 'requestId', 'completedAt'],
  PRIVACY_REQUEST_RECEIVED: ['organisationName', 'requestId', 'requestType', 'targetResponseAt']
};

function renderDataForStorage(input: EnqueueLifecycleEmailInput): LifecycleEmailRenderData {
  if (input.templateVersion !== 1 || !Object.hasOwn(versionOneRenderFields, input.template)) {
    throw new Error('LIFECYCLE_EMAIL_UNSUPPORTED_TEMPLATE');
  }
  const allowed = versionOneRenderFields[input.template];
  const renderData: LifecycleEmailRenderData = {};
  if (!input.renderData || typeof input.renderData !== 'object' || Array.isArray(input.renderData)) {
    throw new Error('LIFECYCLE_EMAIL_INVALID_RENDER_DATA');
  }
  for (const [field, value] of Object.entries(input.renderData)) {
    if (!allowed.includes(field) || !(
      value === null || typeof value === 'string' || typeof value === 'boolean' || Number.isFinite(value)
    )) {
      throw new Error('LIFECYCLE_EMAIL_INVALID_RENDER_DATA');
    }
    renderData[field] = value;
  }
  return renderData;
}

function normaliseRecipient(email: string): string | null {
  const address = email.trim().toLowerCase();
  // Accept one bare mailbox. Display names, address lists and control characters
  // must never reach a mail transport through a customer-supplied address.
  if (address.length > 320 || /[\p{Cc}\s(),;:<>"[\]\\]/u.test(address)) return null;
  if (!/^[^@]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(address)) return null;
  return address;
}

export function lifecycleEmailRecipientKey(email: string): string {
  const recipient = normaliseRecipient(email);
  if (!recipient) throw new Error('LIFECYCLE_EMAIL_INVALID_RECIPIENT');
  return createHash('sha256').update(recipient).digest('hex');
}

function activeAdministrators(organisationId: string | typeof outbox.organisationId) {
  return and(
    eq(memberships.organisationId, organisationId), eq(memberships.role, 'ADMIN'),
    isNull(memberships.disabledAt), isNull(users.disabledAt)
  );
}

export async function listLifecycleEmailAdminRecipients(
  database: EmailDatabase, organisationId: string
): Promise<string[]> {
  const administrators = await database.select({ email: users.email })
    .from(memberships).innerJoin(users, eq(users.id, memberships.userId))
    .where(activeAdministrators(organisationId));
  const addresses = administrators.map(({ email }) => normaliseRecipient(email))
    .filter((address) => address !== null);
  return [...new Set(addresses)].sort();
}

const unsent = () => inArray(outbox.status, ['PENDING', 'RETRY']);
const activeClaim = ({ id, claimToken }: ClaimIdentity) =>
  and(eq(outbox.id, id), eq(outbox.status, 'SENDING'), eq(outbox.claimToken, claimToken));

function validEvidenceId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 512 && value.trim() !== '' && !/\p{Cc}/u.test(value);
}

const localAtom = '[A-Za-z0-9_-]+';
const hostLabel = '[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?';
const generatedMessageId = new RegExp(`^<${localAtom}(?:[.]${localAtom})*@${hostLabel}(?:[.]${hostLabel})*>$`, 'u');

interface StaleSendingCutoff {
  now: Date;
  staleBefore: Date;
}

async function quarantineStaleSending(database: EmailDatabase, { now, staleBefore }: StaleSendingCutoff): Promise<number> {
  if (!(staleBefore < now)) throw new Error('LIFECYCLE_EMAIL_INVALID_STALE_CUTOFF');
  const result = await database.update(outbox)
    .set({ status: 'UNKNOWN', claimToken: null, lastFailureCode: 'STALE_SENDING', updatedAt: now })
    .where(and(eq(outbox.status, 'SENDING'), lte(outbox.lastAttemptedAt, staleBefore)));
  return result.rowCount ?? 0;
}

export class PostgresLifecycleEmailRepository {
  constructor(private readonly database: EmailDatabase) {}

  async enqueue(input: EnqueueLifecycleEmailInput): Promise<boolean> {
    const recipient = normaliseRecipient(input.recipient);
    if (!recipient) throw new Error('LIFECYCLE_EMAIL_INVALID_RECIPIENT');
    const inserted = await this.database.insert(outbox).values({
      organisationId: input.organisationId, recipient, template: input.template,
      templateVersion: input.templateVersion, renderData: renderDataForStorage(input),
      idempotencyKey: input.idempotencyKey, sourceType: input.sourceType, sourceId: input.sourceId,
      availableAt: input.availableAt, expiresAt: input.expiresAt
    }).onConflictDoNothing({ target: [outbox.organisationId, outbox.idempotencyKey] })
      .returning({ id: outbox.id });
    return inserted.length === 1;
  }

  async expireDue({ now }: { now: Date }): Promise<number> {
    const result = await this.database.update(outbox)
      .set({ status: 'CANCELLED', nextAttemptAt: null, updatedAt: now })
      .where(and(unsent(), lte(outbox.expiresAt, now)));
    return result.rowCount ?? 0;
  }

  quarantineStaleSending(input: StaleSendingCutoff): Promise<number> {
    return quarantineStaleSending(this.database, input);
  }

  async claimNext({ now, staleBefore, activatedAt }: StaleSendingCutoff & {
    activatedAt: Date;
  }): Promise<ClaimedLifecycleEmail | null> {
    return this.database.transaction(async (tx) => {
      await quarantineStaleSending(tx, { now, staleBefore });

      const [due] = await tx.select({ id: outbox.id }).from(outbox)
        .where(and(
          gt(outbox.expiresAt, now),
          gte(outbox.createdAt, activatedAt),
          gte(outbox.availableAt, activatedAt),
          or(
            and(eq(outbox.status, 'PENDING'), lte(outbox.availableAt, now)),
            and(eq(outbox.status, 'RETRY'), lte(outbox.nextAttemptAt, now))
          )
        ))
        .orderBy(asc(sql`coalesce(${outbox.nextAttemptAt}, ${outbox.availableAt})`), asc(outbox.id))
        .limit(1).for('update', { skipLocked: true });
      if (!due) return null;

      const claimToken = randomUUID();
      const [claimed] = await tx.update(outbox).set({
        status: 'SENDING', claimToken, attempts: sql`${outbox.attempts} + 1`,
        nextAttemptAt: null, lastAttemptedAt: now, updatedAt: now
      }).where(eq(outbox.id, due.id)).returning();
      if (!claimed) throw new Error('LIFECYCLE_EMAIL_CLAIM_LOST');
      return { ...claimed, status: 'SENDING', claimToken };
    });
  }

  async checkRecipientForDelivery(input: ClaimIdentity): Promise<RecipientDeliveryStatus> {
    const matchingAdmin = this.database.select({ userId: users.id })
      .from(memberships).innerJoin(users, eq(users.id, memberships.userId))
      .where(and(
        activeAdministrators(outbox.organisationId),
        sql`lower(btrim(${users.email})) = ${outbox.recipient}`
      ));
    const [claim] = await this.database.select({
      cancellationRequestedAt: outbox.cancellationRequestedAt,
      hasActiveAdmin: exists(matchingAdmin),
      sourceType: outbox.sourceType,
      template: outbox.template
    }).from(outbox).where(activeClaim(input)).limit(1);
    if (!claim) return 'CLAIM_LOST';
    if (claim.cancellationRequestedAt !== null) return 'NOTICE_CANCELLED_BEFORE_SUBMISSION';
    // Privacy notices use the requester mailbox verified by the owner workflow.
    if (claim.sourceType === 'DATA_REQUEST'
        && (claim.template === 'PRIVACY_REQUEST_RECEIVED' || claim.template === 'EXPORT_DELIVERED')) {
      return 'READY';
    }
    return claim.hasActiveAdmin ? 'READY' : 'RECIPIENT_ACCESS_REVOKED';
  }

  async recordSuppressed(input: ClaimResultInput & { failureCode: DeliverySuppression }): Promise<boolean> {
    const result = await this.database.update(outbox).set({
      status: 'CANCELLED', claimToken: null, lastFailureCode: input.failureCode, updatedAt: input.now
    }).where(activeClaim(input));
    return result.rowCount === 1;
  }

  async recordSent(input: ClaimResultInput & { messageId: string; providerMessageId?: string | null }): Promise<boolean> {
    if (!validEvidenceId(input.messageId) || !generatedMessageId.test(input.messageId)) {
      throw new Error('LIFECYCLE_EMAIL_INVALID_MESSAGE_ID');
    }
    if (input.providerMessageId != null && !validEvidenceId(input.providerMessageId)) {
      throw new Error('LIFECYCLE_EMAIL_INVALID_PROVIDER_MESSAGE_ID');
    }
    const result = await this.database.update(outbox).set({
      status: 'SENT', claimToken: null, sentAt: input.now, updatedAt: input.now,
      messageId: input.messageId, providerMessageId: input.providerMessageId ?? null, lastFailureCode: null
    }).where(activeClaim(input));
    return result.rowCount === 1;
  }

  async recordRetry(input: FailureInput & { nextAttemptAt: Date }): Promise<boolean> {
    if (!(input.nextAttemptAt > input.now)) throw new Error('LIFECYCLE_EMAIL_INVALID_RETRY_TIME');
    const next = input.nextAttemptAt.toISOString();
    const retryAllowed = sql`${outbox.cancellationRequestedAt} is null and ${next}::timestamptz < ${outbox.expiresAt}`;
    const result = await this.database.update(outbox).set({
      status: sql`case when ${retryAllowed} then 'RETRY' else 'CANCELLED' end`,
      nextAttemptAt: sql`case when ${retryAllowed} then ${next}::timestamptz else null end`,
      claimToken: null, lastFailureCode: input.failureCode, updatedAt: input.now
    }).where(activeClaim(input));
    return result.rowCount === 1;
  }

  recordFailed(input: FailureInput): Promise<boolean> {
    return this.finishUnsentClaim(input, 'FAILED');
  }

  recordUnknown(input: FailureInput): Promise<boolean> {
    return this.finishUnsentClaim(input, 'UNKNOWN');
  }

  private async finishUnsentClaim(input: FailureInput, status: 'FAILED' | 'UNKNOWN'): Promise<boolean> {
    const result = await this.database.update(outbox).set({
      status: status === 'UNKNOWN' ? 'UNKNOWN'
        : sql`case when ${outbox.cancellationRequestedAt} is null then 'FAILED' else 'CANCELLED' end`,
      claimToken: null, lastFailureCode: input.failureCode, updatedAt: input.now
    }).where(activeClaim(input));
    return result.rowCount === 1;
  }

  async cancelUnsentForSource(input: {
    organisationId: string; sourceType: string; sourceId: string; template: LifecycleEmailTemplate; now: Date;
  }): Promise<number> {
    const result = await this.database.update(outbox)
      .set({
        status: sql`case when ${outbox.status} = 'SENDING' then 'SENDING' else 'CANCELLED' end`,
        cancellationRequestedAt: input.now, nextAttemptAt: null, updatedAt: input.now
      })
      .where(and(
        inArray(outbox.status, ['PENDING', 'RETRY', 'SENDING']), isNull(outbox.cancellationRequestedAt),
        eq(outbox.organisationId, input.organisationId), eq(outbox.template, input.template),
        eq(outbox.sourceType, input.sourceType), eq(outbox.sourceId, input.sourceId)
      ));
    return result.rowCount ?? 0;
  }
}
