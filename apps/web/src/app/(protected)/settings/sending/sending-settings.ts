import { and, desc, eq, gte } from 'drizzle-orm';
import { parsePhoneNumberFromString } from 'libphonenumber-js';

import { authorise, type AppSession } from '@bc5000/auth';
import { auditEvents, type Database, organisations, providerConnections } from '@bc5000/db/web';

export const LIVE_ACKNOWLEDGEMENT = 'I understand live reminders will be sent to customers';

export function createSendingSettings(dependencies: { database: Database; clock: { now(): Date } }) {
  const updateAllowlist = async (session: AppSession, input: { organisationId: string; recipients: string[] }) => {
    authorise(session, 'provider.configure', input.organisationId);
    const normalised = [...new Set(input.recipients.filter((value) => value.trim() !== '').map((value) => { const parsed = parsePhoneNumberFromString(value, 'AU'); if (!parsed?.isValid()) throw new Error(`INVALID_ALLOWLIST_NUMBER:${value}`); return parsed.number; }))];
    const [before] = await dependencies.database.select({ recipientAllowlist: organisations.recipientAllowlist }).from(organisations).where(eq(organisations.id, input.organisationId)).limit(1); if (!before) throw new Error('ORGANISATION_NOT_FOUND');
    const now = dependencies.clock.now(); await dependencies.database.transaction(async (transaction) => { await transaction.update(organisations).set({ recipientAllowlist: normalised, updatedAt: now }).where(eq(organisations.id, input.organisationId)); await transaction.insert(auditEvents).values({ organisationId: input.organisationId, actorUserId: session.userId, eventType: 'SEND_ALLOWLIST_UPDATED', entityType: 'ORGANISATION', entityId: input.organisationId, beforeValue: { count: before.recipientAllowlist.length }, afterValue: { count: normalised.length }, occurredAt: now }); });
    return { recipients: normalised };
  };

  const activateLive = async (session: AppSession, input: { organisationId: string; acknowledgement: string }) => {
    authorise(session, 'provider.configure', input.organisationId);
    if (input.acknowledgement !== LIVE_ACKNOWLEDGEMENT) throw new Error('ACKNOWLEDGEMENT_MISMATCH');
    const now = dependencies.clock.now(); const [organisation] = await dependencies.database.select().from(organisations).where(eq(organisations.id, input.organisationId)).limit(1); if (!organisation) throw new Error('ORGANISATION_NOT_FOUND');
    const healthySince = new Date(now.getTime() - 24 * 60 * 60 * 1000); const providers = await dependencies.database.select().from(providerConnections).where(and(eq(providerConnections.organisationId, input.organisationId), eq(providerConnections.enabled, true), gte(providerConnections.lastSuccessfulAuthenticationAt, healthySince)));
    if (!['XERO','SINCH'].every((provider) => providers.some((connection) => connection.provider === provider && connection.connectedAt !== null))) throw new Error('PROVIDERS_UNHEALTHY');
    if (organisation.lastSuccessfulSyncAt === null || now.getTime() - organisation.lastSuccessfulSyncAt.getTime() > 15 * 60 * 1000) throw new Error('XERO_SYNC_STALE');
    if (organisation.recipientAllowlist.length === 0) throw new Error('ALLOWLIST_REQUIRED');
    const [controlledTest] = await dependencies.database.select({ id: auditEvents.id }).from(auditEvents).where(and(eq(auditEvents.organisationId, input.organisationId), eq(auditEvents.eventType, 'CONTROLLED_TEST_PASSED'))).orderBy(desc(auditEvents.occurredAt)).limit(1); if (!controlledTest) throw new Error('CONTROLLED_TEST_REQUIRED');
    await dependencies.database.transaction(async (transaction) => { await transaction.update(organisations).set({ sendMode: 'live', liveSendAcknowledged: true, updatedAt: now }).where(eq(organisations.id, input.organisationId)); await transaction.insert(auditEvents).values({ organisationId: input.organisationId, actorUserId: session.userId, eventType: 'LIVE_SENDING_ACTIVATED', entityType: 'ORGANISATION', entityId: input.organisationId, beforeValue: { sendMode: organisation.sendMode }, afterValue: { sendMode: 'live', acknowledgement: LIVE_ACKNOWLEDGEMENT }, occurredAt: now }); });
  };

  const disableLive = async (session: AppSession, input: { organisationId: string; reason: string }) => { authorise(session, 'provider.configure', input.organisationId); const reason=input.reason.trim(); if (!reason) throw new Error('REASON_REQUIRED'); const now=dependencies.clock.now(); await dependencies.database.transaction(async (transaction)=>{ await transaction.update(organisations).set({sendMode:'dry-run',liveSendAcknowledged:false,updatedAt:now}).where(eq(organisations.id,input.organisationId)); await transaction.insert(auditEvents).values({organisationId:input.organisationId,actorUserId:session.userId,eventType:'LIVE_SENDING_DISABLED',entityType:'ORGANISATION',entityId:input.organisationId,afterValue:{sendMode:'dry-run',reason},occurredAt:now}); }); };
  return { updateAllowlist, activateLive, disableLive };
}
