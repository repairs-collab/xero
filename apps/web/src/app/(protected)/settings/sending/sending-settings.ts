import { and, eq, gte } from 'drizzle-orm';
import { parsePhoneNumberFromString } from 'libphonenumber-js';

import { authorise, type AppSession } from '@bc5000/auth';
import { auditEvents, type Database, organisations, providerConnections } from '@bc5000/db/web';

export const LIVE_ACKNOWLEDGEMENT = 'I understand live reminders will be sent to customers';

export interface LiveActivationFeedback {
  tone: 'error' | 'success';
  title: string;
  detail: string;
}

const activationErrors = new Set([
  'ACKNOWLEDGEMENT_MISMATCH',
  'PROVIDERS_UNHEALTHY',
  'XERO_SYNC_STALE',
  'ALLOWLIST_REQUIRED',
  'FORBIDDEN'
]);

export const liveActivationStatusForError = (error: unknown): string =>
  error instanceof Error && activationErrors.has(error.message)
    ? error.message
    : 'ACTIVATION_FAILED';

export const liveActivationFeedback = (
  status: string | string[] | undefined
): LiveActivationFeedback | null => {
  const value = Array.isArray(status) ? status[0] : status;
  switch (value) {
    case 'enabled':
      return {
        tone: 'success',
        title: 'Controlled live mode enabled',
        detail:
          'Provider calls are open only for destinations on the technical recipient allowlist. Complete the controlled tests before the final customer rollout.'
      };
    case 'ACKNOWLEDGEMENT_MISMATCH':
      return {
        tone: 'error',
        title: 'The acknowledgement did not match',
        detail: 'Type the acknowledgement exactly as shown, then try again.'
      };
    case 'PROVIDERS_UNHEALTHY':
      return {
        tone: 'error',
        title: 'Provider checks are out of date',
        detail:
          'Run successful Xero and Sinch connection tests, then try again within 24 hours.'
      };
    case 'XERO_SYNC_STALE':
      return {
        tone: 'error',
        title: 'Xero data is not fresh enough',
        detail: 'Run a Xero sync, then try again within 15 minutes.'
      };
    case 'ALLOWLIST_REQUIRED':
      return {
        tone: 'error',
        title: 'Add a controlled recipient first',
        detail:
          'Add at least one company-controlled phone number or email address to the recipient allowlist.'
      };
    case 'FORBIDDEN':
      return {
        tone: 'error',
        title: 'Administrator access is required',
        detail: 'Only an AccountPulse administrator can enable live sending.'
      };
    case undefined:
      return null;
    default:
      return {
        tone: 'error',
        title: 'Live sending was not enabled',
        detail:
          'No provider calls were opened. Refresh the page and check each launch-readiness item before trying again.'
      };
  }
};

const normaliseAllowlistRecipient = (rawValue: string): string => {
  const value = rawValue.trim();
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    return value.toLowerCase();
  }
  const parsed = parsePhoneNumberFromString(value, 'AU');
  if (!parsed?.isValid()) throw new Error(`INVALID_ALLOWLIST_RECIPIENT:${rawValue}`);
  return parsed.number;
};

export function createSendingSettings(dependencies: { database: Database; clock: { now(): Date } }) {
  const updateAllowlist = async (session: AppSession, input: { organisationId: string; recipients: string[] }) => {
    authorise(session, 'provider.configure', input.organisationId);
    const normalised = [...new Set(input.recipients.filter((value) => value.trim() !== '').map(normaliseAllowlistRecipient))];
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
    await dependencies.database.transaction(async (transaction) => { await transaction.update(organisations).set({ sendMode: 'live', liveSendAcknowledged: true, updatedAt: now }).where(eq(organisations.id, input.organisationId)); await transaction.insert(auditEvents).values({ organisationId: input.organisationId, actorUserId: session.userId, eventType: 'LIVE_SENDING_ACTIVATED', entityType: 'ORGANISATION', entityId: input.organisationId, beforeValue: { sendMode: organisation.sendMode }, afterValue: { sendMode: 'live', acknowledgement: LIVE_ACKNOWLEDGEMENT }, occurredAt: now }); });
  };

  const disableLive = async (session: AppSession, input: { organisationId: string; reason: string }) => { authorise(session, 'provider.configure', input.organisationId); const reason=input.reason.trim(); if (!reason) throw new Error('REASON_REQUIRED'); const now=dependencies.clock.now(); await dependencies.database.transaction(async (transaction)=>{ await transaction.update(organisations).set({sendMode:'dry-run',liveSendAcknowledged:false,updatedAt:now}).where(eq(organisations.id,input.organisationId)); await transaction.insert(auditEvents).values({organisationId:input.organisationId,actorUserId:session.userId,eventType:'LIVE_SENDING_DISABLED',entityType:'ORGANISATION',entityId:input.organisationId,afterValue:{sendMode:'dry-run',reason},occurredAt:now}); }); };
  return { updateAllowlist, activateLive, disableLive };
}
