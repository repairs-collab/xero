import { and, eq } from 'drizzle-orm';

import { authorise, type AppSession } from '@bc5000/auth';
import {
  auditEvents,
  type Database,
  PostgresOrganisationSafetyRepository,
  providerConnections
} from '@bc5000/db/web';
import { jobNames, type JobPublisher } from '@bc5000/jobs';

type Provider = 'XERO' | 'SINCH';
export interface ConnectionTestResult { healthy: boolean; requiredScopes?: string[]; details?: Record<string, unknown>; }
export interface ProviderConnectionTester { test(input: { provider: Provider; secretArn: string; organisationId: string }): Promise<ConnectionTestResult>; }
const referenceSuffix = (reference: string) => reference.split(':').at(-1)?.slice(-24) ?? reference.slice(-24);
const validSecretArn = (value: string) => /^arn:aws:secretsmanager:ap-southeast-2:\d{3,}:secret:[A-Za-z0-9/_+=.@-]+$/.test(value);

export function createIntegrationSettings(dependencies: { database: Database; tester: ProviderConnectionTester; publisher?: JobPublisher; clock: { now(): Date } }) {
  const safety = new PostgresOrganisationSafetyRepository(dependencies.database);
  const replaceSecretReference = async (session: AppSession, input: { organisationId: string; provider: Provider; secretArn: string }) => {
    authorise(session, 'provider.configure', input.organisationId); if (!validSecretArn(input.secretArn)) throw new Error('SECRET_REFERENCE_REQUIRED'); const now=dependencies.clock.now();
    const [before]=await dependencies.database.select().from(providerConnections).where(and(eq(providerConnections.organisationId,input.organisationId),eq(providerConnections.provider,input.provider))).limit(1);
    await dependencies.database.transaction(async(transaction)=>{await transaction.insert(providerConnections).values({organisationId:input.organisationId,provider:input.provider,secretArn:input.secretArn,enabled:true,updatedAt:now}).onConflictDoUpdate({target:[providerConnections.organisationId,providerConnections.provider],set:{secretArn:input.secretArn,enabled:true,connectedAt:null,lastSuccessfulAuthenticationAt:null,updatedAt:now}});await transaction.insert(auditEvents).values({organisationId:input.organisationId,actorUserId:session.userId,eventType:'PROVIDER_SECRET_REFERENCE_CHANGED',entityType:'PROVIDER_CONNECTION',entityId:input.provider,beforeValue:{referenceSuffix:before?referenceSuffix(before.secretArn):null},afterValue:{referenceSuffix:referenceSuffix(input.secretArn),healthEvidenceInvalidated:true},occurredAt:now});});
  };
  const rotateCallbackKeyReference = async(session:AppSession,input:{organisationId:string;keyId:string})=>{authorise(session,'provider.configure',input.organisationId);const keyId=input.keyId.trim();if(!/^[A-Za-z0-9._:/-]{3,128}$/.test(keyId)||keyId.includes('BEGIN'))throw new Error('CALLBACK_KEY_REFERENCE_REQUIRED');const now=dependencies.clock.now();const [before]=await dependencies.database.select().from(providerConnections).where(and(eq(providerConnections.organisationId,input.organisationId),eq(providerConnections.provider,'SINCH'))).limit(1);if(!before)throw new Error('SINCH_CONNECTION_NOT_FOUND');await dependencies.database.transaction(async(transaction)=>{await transaction.update(providerConnections).set({callbackKeyId:keyId,updatedAt:now}).where(eq(providerConnections.id,before.id));await transaction.insert(auditEvents).values({organisationId:input.organisationId,actorUserId:session.userId,eventType:'SINCH_CALLBACK_KEY_ROTATED',entityType:'PROVIDER_CONNECTION',entityId:before.id,beforeValue:{keyId:before.callbackKeyId},afterValue:{keyId},occurredAt:now});});};
  const testConnection = async (
    session: AppSession,
    input: { organisationId: string; provider: Provider }
  ) => {
    authorise(session, 'provider.configure', input.organisationId);
    const [connection] = await dependencies.database
      .select()
      .from(providerConnections)
      .where(
        and(
          eq(providerConnections.organisationId, input.organisationId),
          eq(providerConnections.provider, input.provider)
        )
      )
      .limit(1);
    if (!connection) throw new Error('PROVIDER_CONNECTION_NOT_FOUND');
    const result = await dependencies.tester.test({
      provider: input.provider,
      secretArn: connection.secretArn,
      organisationId: input.organisationId
    });
    const now = dependencies.clock.now();
    let staleResult = false;
    await dependencies.database.transaction(async (transaction) => {
      if (result.healthy) {
        const updated = await transaction
          .update(providerConnections)
          .set({
            connectedAt: connection.connectedAt ?? now,
            lastSuccessfulAuthenticationAt: now,
            updatedAt: now
          })
          .where(
            and(
              eq(providerConnections.id, connection.id),
              eq(providerConnections.secretArn, connection.secretArn)
            )
          )
          .returning({ id: providerConnections.id });
        staleResult = updated.length === 0;
      }
      await transaction.insert(auditEvents).values({
        organisationId: input.organisationId,
        actorUserId: session.userId,
        eventType: 'PROVIDER_CONNECTION_TESTED',
        entityType: 'PROVIDER_CONNECTION',
        entityId: connection.id,
        afterValue: {
          provider: input.provider,
          healthy: result.healthy && !staleResult,
          probeHealthy: result.healthy,
          staleResult,
          requiredScopes: result.requiredScopes ?? [],
          referenceSuffix: referenceSuffix(connection.secretArn)
        },
        occurredAt: now
      });
    });
    if (staleResult) {
      throw new Error('PROVIDER_CONNECTION_CHANGED_DURING_TEST');
    }
    return result;
  };
  const requestXeroSync = async (
    session: AppSession,
    input: { organisationId: string }
  ) => {
    authorise(session, 'provider.configure', input.organisationId);
    if (!dependencies.publisher) throw new Error('JOB_PUBLISHER_REQUIRED');
    const [connection] = await dependencies.database
      .select({ id: providerConnections.id })
      .from(providerConnections)
      .where(
        and(
          eq(providerConnections.organisationId, input.organisationId),
          eq(providerConnections.provider, 'XERO'),
          eq(providerConnections.enabled, true)
        )
      )
      .limit(1);
    if (!connection) throw new Error('XERO_CONNECTION_NOT_FOUND');
    const now = dependencies.clock.now();
    const auditEvent = await dependencies.database.transaction(
      async (transaction) => {
        await safety.assertOperationalMutationAllowed(
          transaction,
          input.organisationId
        );
        const [created] = await transaction
          .insert(auditEvents)
          .values({
            organisationId: input.organisationId,
            actorUserId: session.userId,
            eventType: 'XERO_SYNC_REQUESTED',
            entityType: 'ORGANISATION',
            entityId: input.organisationId,
            afterValue: {
              jobName: jobNames.xeroIncrementalSync,
              state: 'REQUESTED'
            },
            occurredAt: now
          })
          .returning({ id: auditEvents.id });
        if (!created) throw new Error('XERO_SYNC_AUDIT_NOT_CREATED');
        return created;
      }
    );
    let jobId: string;
    try {
      jobId = await dependencies.publisher.publish(
        jobNames.xeroIncrementalSync,
        { organisationId: input.organisationId },
        {
          singletonKey: `${jobNames.xeroIncrementalSync}:${input.organisationId}`,
          deduplicateWhileActive: true
        }
      );
    } catch (error) {
      await dependencies.database.insert(auditEvents).values({
        organisationId: input.organisationId,
        actorUserId: session.userId,
        eventType: 'XERO_SYNC_QUEUE_FAILED',
        entityType: 'ORGANISATION',
        entityId: input.organisationId,
        afterValue: {
          requestAuditId: auditEvent.id,
          jobName: jobNames.xeroIncrementalSync,
          state: 'FAILED'
        },
        occurredAt: dependencies.clock.now()
      });
      throw error;
    }
    await dependencies.database.insert(auditEvents).values({
      organisationId: input.organisationId,
      actorUserId: session.userId,
      eventType: 'XERO_SYNC_QUEUED',
      entityType: 'ORGANISATION',
      entityId: input.organisationId,
      afterValue: {
        requestAuditId: auditEvent.id,
        jobId,
        jobName: jobNames.xeroIncrementalSync,
        state: 'QUEUED'
      },
      occurredAt: dependencies.clock.now()
    });
    return { jobId };
  };
  return { replaceSecretReference, rotateCallbackKeyReference, testConnection, requestXeroSync };
}
