import {
  createHash,
  createHmac,
  timingSafeEqual
} from 'node:crypto';

import { eq } from 'drizzle-orm';
import { parsePhoneNumberFromString } from 'libphonenumber-js';

import { authorise, type AppSession } from '@bc5000/auth';
import {
  auditEvents,
  type Database,
  organisationOnboarding,
  outboundMessages
} from '@bc5000/db/web';

export type MobileVerificationResult =
  | 'VERIFIED'
  | 'INVALID'
  | 'EXPIRED'
  | 'LOCKED';

export interface MobileVerificationRepository {
  begin(input: {
    organisationId: string;
    actorUserId: string;
    destination: string;
    codeHash: string;
    content: string;
    expiresAt: Date;
    occurredAt: Date;
  }): Promise<{ outboundMessageId: string }>;
  verify(input: {
    organisationId: string;
    actorUserId: string;
    code: string;
    occurredAt: Date;
  }): Promise<MobileVerificationResult>;
}

const otpHash = (
  secret: Uint8Array,
  organisationId: string,
  actorUserId: string,
  destination: string,
  code: string
): string =>
  createHmac('sha256', secret)
    .update(`${organisationId}:${actorUserId}:${destination}:${code}`)
    .digest('hex');

const normaliseAustralianMobile = (value: string): string => {
  const parsed = parsePhoneNumberFromString(value.trim(), 'AU');
  if (
    parsed?.country !== 'AU' ||
    !parsed.isValid() ||
    parsed.getType() !== 'MOBILE'
  ) {
    throw new Error('INVALID_AU_MOBILE_NUMBER');
  }
  return parsed.number;
};

export const createPostgresMobileVerificationRepository = (
  database: Database,
  hmacSecret: Uint8Array
): MobileVerificationRepository => ({
  begin: (input) =>
    database.transaction(async (transaction) => {
      const [current] = await transaction
        .select({ sentAt: organisationOnboarding.adminMobileOtpSentAt })
        .from(organisationOnboarding)
        .where(
          eq(organisationOnboarding.organisationId, input.organisationId)
        )
        .for('update')
        .limit(1);
      if (current === undefined) throw new Error('ONBOARDING_NOT_FOUND');
      if (
        current.sentAt !== null &&
        input.occurredAt.getTime() - current.sentAt.getTime() < 60_000
      ) {
        throw new Error('MOBILE_VERIFICATION_RATE_LIMITED');
      }
      await transaction
        .update(organisationOnboarding)
        .set({
          pendingAdminMobile: input.destination,
          adminMobileOtpHash: input.codeHash,
          adminMobileOtpExpiresAt: input.expiresAt,
          adminMobileOtpAttempts: 0,
          adminMobileOtpSentAt: input.occurredAt,
          updatedAt: input.occurredAt
        })
        .where(
          eq(organisationOnboarding.organisationId, input.organisationId)
        );
      const [outbound] = await transaction
        .insert(outboundMessages)
        .values({
          organisationId: input.organisationId,
          actorUserId: input.actorUserId,
          channel: 'SMS',
          source: 'VERIFICATION_OTP',
          recipientKey: input.destination,
          content: input.content,
          contentHash: createHash('sha256').update(input.content).digest('hex'),
          status: 'QUEUED',
          idempotencyKey: `verification-otp:${input.occurredAt.toISOString()}`,
          queuedAt: input.occurredAt,
          updatedAt: input.occurredAt
        })
        .returning({ id: outboundMessages.id });
      if (outbound === undefined) throw new Error('OTP_OUTBOUND_NOT_CREATED');
      await transaction.insert(auditEvents).values({
        organisationId: input.organisationId,
        actorUserId: input.actorUserId,
        eventType: 'ADMIN_MOBILE_VERIFICATION_REQUESTED',
        entityType: 'ORGANISATION_ONBOARDING',
        entityId: input.organisationId,
        afterValue: {
          destinationHash: createHash('sha256')
            .update(input.destination)
            .digest('hex'),
          expiresAt: input.expiresAt.toISOString(),
          outboundMessageId: outbound.id
        },
        occurredAt: input.occurredAt
      });
      return { outboundMessageId: outbound.id };
    }),
  verify: (input) =>
    database.transaction(async (transaction) => {
      const [pending] = await transaction
        .select({
          destination: organisationOnboarding.pendingAdminMobile,
          codeHash: organisationOnboarding.adminMobileOtpHash,
          expiresAt: organisationOnboarding.adminMobileOtpExpiresAt,
          attempts: organisationOnboarding.adminMobileOtpAttempts
        })
        .from(organisationOnboarding)
        .where(
          eq(organisationOnboarding.organisationId, input.organisationId)
        )
        .for('update')
        .limit(1);
      if (
        pending === undefined ||
        pending.destination === null ||
        pending.codeHash === null ||
        pending.expiresAt === null ||
        pending.attempts === null
      ) {
        return 'EXPIRED';
      }
      if (pending.expiresAt.getTime() <= input.occurredAt.getTime()) {
        return 'EXPIRED';
      }
      if (pending.attempts >= 5) return 'LOCKED';
      const suppliedHash = otpHash(
        hmacSecret,
        input.organisationId,
        input.actorUserId,
        pending.destination,
        input.code
      );
      const supplied = Buffer.from(suppliedHash, 'hex');
      const expected = Buffer.from(pending.codeHash, 'hex');
      const matches =
        supplied.length === expected.length &&
        timingSafeEqual(supplied, expected);
      if (!matches) {
        const attempts = pending.attempts + 1;
        await transaction
          .update(organisationOnboarding)
          .set({
            adminMobileOtpAttempts: attempts,
            updatedAt: input.occurredAt
          })
          .where(
            eq(organisationOnboarding.organisationId, input.organisationId)
          );
        return attempts >= 5 ? 'LOCKED' : 'INVALID';
      }
      await transaction
        .update(organisationOnboarding)
        .set({
          adminMobile: pending.destination,
          adminMobileVerifiedAt: input.occurredAt,
          pendingAdminMobile: null,
          adminMobileOtpHash: null,
          adminMobileOtpExpiresAt: null,
          adminMobileOtpAttempts: null,
          adminMobileOtpSentAt: null,
          updatedAt: input.occurredAt
        })
        .where(
          eq(organisationOnboarding.organisationId, input.organisationId)
        );
      await transaction.insert(auditEvents).values({
        organisationId: input.organisationId,
        actorUserId: input.actorUserId,
        eventType: 'ADMIN_MOBILE_VERIFIED',
        entityType: 'ORGANISATION_ONBOARDING',
        entityId: input.organisationId,
        afterValue: { verified: true },
        occurredAt: input.occurredAt
      });
      return 'VERIFIED';
    })
});

export const createMobileVerificationService = (dependencies: {
  repository: MobileVerificationRepository;
  publish(
    organisationId: string,
    outboundMessageId: string
  ): Promise<string>;
  clock: { now(): Date };
  codeGenerator(): string;
  hmacSecret: Uint8Array;
}) => ({
  requestCode: async (
    session: AppSession,
    input: { organisationId: string; mobile: string }
  ) => {
    authorise(session, 'provider.configure', input.organisationId);
    const destination = normaliseAustralianMobile(input.mobile);
    const code = dependencies.codeGenerator();
    if (!/^\d{6}$/.test(code)) throw new Error('INVALID_GENERATED_OTP');
    const occurredAt = dependencies.clock.now();
    const created = await dependencies.repository.begin({
      organisationId: input.organisationId,
      actorUserId: session.userId,
      destination,
      codeHash: otpHash(
        dependencies.hmacSecret,
        input.organisationId,
        session.userId,
        destination,
        code
      ),
      content: `Your AccountPulse verification code is ${code}. It expires in 10 minutes.`,
      expiresAt: new Date(occurredAt.getTime() + 10 * 60 * 1000),
      occurredAt
    });
    const jobId = await dependencies.publish(
      input.organisationId,
      created.outboundMessageId
    );
    return { destination, jobId };
  },
  verifyCode: async (
    session: AppSession,
    input: { organisationId: string; code: string }
  ) => {
    authorise(session, 'provider.configure', input.organisationId);
    const code = input.code.trim();
    if (!/^\d{6}$/.test(code)) {
      throw new Error('INVALID_MOBILE_VERIFICATION_CODE');
    }
    return dependencies.repository.verify({
      organisationId: input.organisationId,
      actorUserId: session.userId,
      code,
      occurredAt: dependencies.clock.now()
    });
  }
});
