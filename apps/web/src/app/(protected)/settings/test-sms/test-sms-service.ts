import { createHash } from 'node:crypto';

import { and, eq } from 'drizzle-orm';
import { parsePhoneNumberFromString } from 'libphonenumber-js';

import { authorise, type AppSession } from '@bc5000/auth';
import {
  auditEvents,
  type Database,
  outboundMessages,
  PostgresOrganisationSafetyRepository
} from '@bc5000/db/web';
import { renderSms } from '@bc5000/domain';
import { jobNames, type JobPublisher } from '@bc5000/jobs';

export const TEST_SMS_MAX_SEGMENTS = 3;

export interface TestSmsServiceDependencies {
  database: Database;
  publisher: JobPublisher;
  clock: { now(): Date };
}

export interface QueueTestSmsInput {
  organisationId: string;
  destination: string;
  content: string;
  confirmed: boolean;
  requestId: string;
}

const normaliseAustralianNumber = (rawValue: string): string => {
  const parsed = parsePhoneNumberFromString(rawValue.trim(), 'AU');
  if (
    parsed?.country !== 'AU' ||
    !parsed.isValid() ||
    parsed.getType() !== 'MOBILE'
  ) {
    throw new Error('INVALID_AU_MOBILE_NUMBER');
  }
  return parsed.number;
};

export function createTestSmsService(
  dependencies: TestSmsServiceDependencies
) {
  const safety = new PostgresOrganisationSafetyRepository(dependencies.database);
  const queue = async (session: AppSession, input: QueueTestSmsInput) => {
    authorise(session, 'message.test-sms', input.organisationId);
    if (!input.confirmed) throw new Error('TEST_SMS_CONFIRMATION_REQUIRED');
    if (input.requestId.trim() === '') throw new Error('TEST_SMS_REQUEST_ID_REQUIRED');
    if (input.content.trim() === '') throw new Error('TEST_SMS_CONTENT_REQUIRED');

    const destination = normaliseAustralianNumber(input.destination);
    let rendered;
    try {
      rendered = renderSms(input.content, {}, { maxSegments: TEST_SMS_MAX_SEGMENTS });
    } catch (error) {
      if (error instanceof Error && error.message.includes('segment limit')) {
        throw new Error('TEST_SMS_EXCEEDS_3_SEGMENT_LIMIT');
      }
      throw error;
    }
    const now = dependencies.clock.now();
    const idempotencyKey = `test-sms:${input.requestId.trim()}`;
    const stored = await dependencies.database.transaction(async (transaction) => {
      await safety.assertOperationalMutationAllowed(
        transaction,
        input.organisationId
      );
      const [created] = await transaction
        .insert(outboundMessages)
        .values({
          organisationId: input.organisationId,
          actorUserId: session.userId,
          channel: 'SMS',
          source: 'TEST_SMS',
          recipientKey: destination,
          content: input.content,
          contentHash: createHash('sha256').update(input.content).digest('hex'),
          status: 'QUEUED',
          idempotencyKey,
          queuedAt: now,
          updatedAt: now
        })
        .onConflictDoNothing({
          target: [
            outboundMessages.organisationId,
            outboundMessages.idempotencyKey
          ]
        })
        .returning({
          id: outboundMessages.id,
          status: outboundMessages.status
        });
      if (created !== undefined) {
        await transaction.insert(auditEvents).values({
          organisationId: input.organisationId,
          actorUserId: session.userId,
          eventType: 'TEST_SMS_QUEUED',
          entityType: 'OUTBOUND_MESSAGE',
          entityId: created.id,
          afterValue: {
            destination,
            requestId: input.requestId.trim(),
            encoding: rendered.encoding,
            segmentCount: rendered.segmentCount
          },
          occurredAt: now
        });
        return created;
      }
      const [existing] = await transaction
        .select({ id: outboundMessages.id, status: outboundMessages.status })
        .from(outboundMessages)
        .where(
          and(
            eq(outboundMessages.organisationId, input.organisationId),
            eq(outboundMessages.idempotencyKey, idempotencyKey)
          )
        )
        .limit(1);
      if (existing === undefined) {
        throw new Error('TEST_SMS_IDEMPOTENCY_CONFLICT');
      }
      return existing;
    });

    const jobId = await dependencies.publisher.publish(
      jobNames.testSmsExecute,
      {
        organisationId: input.organisationId,
        outboundMessageId: stored.id
      },
      { singletonKey: `test-sms:${stored.id}` }
    );
    return {
      outboundMessageId: stored.id,
      jobId,
      destination,
      status: stored.status,
      encoding: rendered.encoding,
      segmentCount: rendered.segmentCount
    };
  };

  return { queue };
}
