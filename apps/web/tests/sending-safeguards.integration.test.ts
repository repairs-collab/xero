import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AppSession } from '@bc5000/auth';
import { auditEvents, createDatabase, migrateDatabase, organisations, providerConnections, users } from '@bc5000/db';

import { createSendingSettings, liveActivationFeedback, LIVE_ACKNOWLEDGEMENT } from '../src/app/(protected)/settings/sending/sending-settings.js';

const client = createDatabase(process.env.DATABASE_URL ?? 'postgres://bc5000:bc5000@localhost:5432/bc5000'); const now = new Date('2026-09-18T02:00:00.000Z');
beforeAll(async () => migrateDatabase(client.db)); afterAll(async () => client.pool.end());
async function seed() { const organisationId = randomUUID(); const userId = randomUUID(); await client.db.insert(organisations).values({ id: organisationId, xeroOrganisationId: randomUUID(), name: 'Sending test', timeZone: 'Australia/Sydney', baseCurrency: 'AUD', lastSuccessfulSyncAt: new Date(now.getTime()-5*60_000) }); await client.db.insert(users).values({ id:userId,cognitoSubject:randomUUID(),email:`${userId}@example.invalid`,displayName:'Admin' }); const session = (role:'ADMIN'|'OPERATOR'):AppSession => ({ userId,cognitoSubject:randomUUID(),displayName:'User',expiresAt:'2026-09-18T10:00:00Z',memberships:[{organisationId,role,active:true}] }); return {organisationId,userId,session}; }

describe('global sending safeguards', () => {
  it('explains why controlled live activation was refused without exposing internal errors', () => {
    expect(liveActivationFeedback('PROVIDERS_UNHEALTHY')).toMatchObject({ tone:'error', title:'Provider checks are out of date' });
    expect(liveActivationFeedback('XERO_SYNC_STALE')).toMatchObject({ tone:'error', title:'Xero data is not fresh enough' });
    expect(liveActivationFeedback('ALLOWLIST_REQUIRED')).toMatchObject({ tone:'error', title:'Add a controlled recipient first' });
    expect(liveActivationFeedback('enabled')).toMatchObject({ tone:'success', title:'Controlled live mode enabled' });
    expect(liveActivationFeedback('database-password')).toMatchObject({ tone:'error', title:'Live sending was not enabled' });
  });
  it('normalises the allowlist and keeps dry-run as the safe default', async () => { const seeded=await seed(); const service=createSendingSettings({database:client.db,clock:{now:()=>now}}); await service.updateAllowlist(seeded.session('ADMIN'),{organisationId:seeded.organisationId,recipients:['0400 000 001','+61 400 000 001']}); const [org]=await client.db.select().from(organisations).where(eq(organisations.id,seeded.organisationId)); expect(org).toMatchObject({sendMode:'dry-run',recipientAllowlist:['+61400000001']}); });
  it('normalises email destinations for allowlisted Xero invoice emails', async () => { const seeded=await seed(); const service=createSendingSettings({database:client.db,clock:{now:()=>now}}); await service.updateAllowlist(seeded.session('ADMIN'),{organisationId:seeded.organisationId,recipients:[' Accounts@Example.COM ','accounts@example.com']}); const [org]=await client.db.select().from(organisations).where(eq(organisations.id,seeded.organisationId)); expect(org?.recipientAllowlist).toEqual(['accounts@example.com']); });
  it('denies an Operator but permits a controlled first activation before the end-to-end test', async () => { const seeded=await seed(); const service=createSendingSettings({database:client.db,clock:{now:()=>now}}); await expect(service.activateLive(seeded.session('OPERATOR'),{organisationId:seeded.organisationId,acknowledgement:LIVE_ACKNOWLEDGEMENT})).rejects.toThrow('FORBIDDEN'); await expect(service.activateLive(seeded.session('ADMIN'),{organisationId:seeded.organisationId,acknowledgement:LIVE_ACKNOWLEDGEMENT})).rejects.toThrow('PROVIDERS_UNHEALTHY'); await client.db.insert(providerConnections).values([{organisationId:seeded.organisationId,provider:'XERO',secretArn:'arn:aws:secretsmanager:ap-southeast-2:123:secret:xero',enabled:true,connectedAt:now,lastSuccessfulAuthenticationAt:now},{organisationId:seeded.organisationId,provider:'SINCH',secretArn:'arn:aws:secretsmanager:ap-southeast-2:123:secret:sinch',enabled:true,connectedAt:now,lastSuccessfulAuthenticationAt:now}]); await service.updateAllowlist(seeded.session('ADMIN'),{organisationId:seeded.organisationId,recipients:['0400 000 001']}); await service.activateLive(seeded.session('ADMIN'),{organisationId:seeded.organisationId,acknowledgement:LIVE_ACKNOWLEDGEMENT}); const [org]=await client.db.select().from(organisations).where(eq(organisations.id,seeded.organisationId)); expect(org).toMatchObject({sendMode:'live',liveSendAcknowledged:true,recipientAllowlist:['+61400000001']}); const events=await client.db.select().from(auditEvents).where(eq(auditEvents.organisationId,seeded.organisationId)); expect(events.map((event)=>event.eventType)).toContain('LIVE_SENDING_ACTIVATED'); });
});
