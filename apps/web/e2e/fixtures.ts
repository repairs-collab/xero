import { createHash, randomUUID } from 'node:crypto';

import type { Page } from '@playwright/test';
import { and, desc, eq, sql } from 'drizzle-orm';

import { createSessionCookie } from '@bc5000/auth';
import {
  auditEvents,
  contactChannels,
  createDatabase,
  invoiceChases,
  invoices,
  organisations,
  organisationVoiceSettings,
  pauses,
  suppressions,
  tasks,
  voiceCallEvents,
  voiceCallRequests
} from '@bc5000/db';
import { fixedVoiceCallCopy } from '@bc5000/domain';
import {
  type FinalRolloutScenarioName,
  launchScenario,
  seedLaunchScenario,
  seedSmsOptOut as applySmsOptOut
} from '@bc5000/testing';

const databaseUrl =
  process.env.DATABASE_URL ??
  'postgres://bc5000:bc5000@127.0.0.1:5432/bc5000';
const sessionSecret = Buffer.alloc(32);

export const resetLaunchScenario = (
  scenario: FinalRolloutScenarioName = 'dryRun'
): Promise<void> => seedLaunchScenario(databaseUrl, scenario);

export const seedSmsOptOut = (): Promise<void> => applySmsOptOut(databaseUrl);

const futureInvoiceId = '10000000-0000-4000-8000-000000000014';
const voiceCallFlowHash = `sha256:${createHash('sha256')
  .update(JSON.stringify(fixedVoiceCallCopy))
  .digest('hex')}`;

export async function seedVoiceScenario(
  options: { enabled?: boolean; ready?: boolean } = {}
): Promise<void> {
  const client = createDatabase(databaseUrl);
  const now = new Date();
  try {
    await client.db
      .delete(contactChannels)
      .where(
        and(
          eq(contactChannels.organisationId, launchScenario.organisationId),
          eq(contactChannels.contactId, launchScenario.contactId),
          eq(contactChannels.kind, 'VOICE')
        )
      );
    await client.db.insert(contactChannels).values({
      organisationId: launchScenario.organisationId,
      contactId: launchScenario.contactId,
      kind: 'VOICE',
      sourceValue: '0400 000 001',
      normalisedValue: launchScenario.mobile,
      usable: true
    });
    await client.db
      .update(invoiceChases)
      .set({ status: 'ACTIVE', updatedAt: now })
      .where(eq(invoiceChases.id, launchScenario.chaseId));
    await client.db
      .update(pauses)
      .set({ active: false, endedAt: now })
      .where(eq(pauses.contactId, launchScenario.contactId));
    await client.db
      .insert(invoices)
      .values({
        id: futureInvoiceId,
        organisationId: launchScenario.organisationId,
        xeroInvoiceId: 'xero-invoice-future-1',
        contactId: launchScenario.contactId,
        invoiceNumber: 'INV-FUTURE-1',
        type: 'ACCREC',
        status: 'AUTHORISED',
        issueDate: '2026-10-01',
        dueDate: '2099-01-01',
        amountDue: '50.0000',
        total: '50.0000',
        currency: 'AUD',
        syncVersion: 1,
        xeroUpdatedAt: now
      })
      .onConflictDoNothing();
    await client.db
      .insert(organisationVoiceSettings)
      .values({
        organisationId: launchScenario.organisationId,
        enabled: options.enabled ?? false,
        configurationVersion: 1,
        secretReference: 'env:RETELL_API_KEY',
        previewPublicKey: 'public_key_e2e_domain_restricted',
        agentId: 'agent_accountpulse',
        agentVersion: 1,
        voiceId: 'voice_au',
        voiceLabel: 'Australian English',
        outboundNumber: '+61255501234',
        transferSipUri: 'sip:accounts@voipline.test',
        fallbackOfficeNumber: '+61255504321',
        officeDestinationLabel: 'Main office',
        timezone: 'Australia/Sydney',
        weekdayStartLocal: '00:01:00',
        weekdayEndLocal: '23:59:00',
        lastConnectionTestedAt: options.ready ? now : null,
        lastConnectionTestSucceeded: options.ready ?? false,
        updatedByUserId: launchScenario.adminUserId,
        updatedAt: now
      })
      .onConflictDoUpdate({
        target: organisationVoiceSettings.organisationId,
        set: {
          enabled: options.enabled ?? false,
          lastConnectionTestedAt: options.ready ? now : null,
          lastConnectionTestSucceeded: options.ready ?? false,
          updatedAt: now
        }
      });
    if (options.ready) await recordVoicePreviewEvidence(client);
  } finally {
    await client.pool.end();
  }
}

export async function recordVoicePreviewEvidence(
  existingClient?: ReturnType<typeof createDatabase>
): Promise<void> {
  const client = existingClient ?? createDatabase(databaseUrl);
  try {
    const [settings] = await client.db
      .select()
      .from(organisationVoiceSettings)
      .where(
        eq(
          organisationVoiceSettings.organisationId,
          launchScenario.organisationId
        )
      )
      .limit(1);
    if (!settings) throw new Error('E2E voice settings not found');
    await client.db.insert(auditEvents).values({
      organisationId: launchScenario.organisationId,
      actorUserId: launchScenario.adminUserId,
      eventType: 'VOICE_GENERIC_FLOW_TESTED',
      entityType: 'ORGANISATION_VOICE_SETTINGS',
      entityId: launchScenario.organisationId,
      afterValue: {
        passed: true,
        configurationVersion: settings.configurationVersion,
        callFlowHash: voiceCallFlowHash,
        callFlowVersion: fixedVoiceCallCopy.version,
        agentId: settings.agentId,
        agentVersion: settings.agentVersion,
        voiceId: settings.voiceId
      },
      occurredAt: new Date()
    });
  } finally {
    if (existingClient === undefined) await client.pool.end();
  }
}

export async function readVoiceEnabled(): Promise<boolean> {
  const client = createDatabase(databaseUrl);
  try {
    const [settings] = await client.db
      .select({ enabled: organisationVoiceSettings.enabled })
      .from(organisationVoiceSettings)
      .where(
        eq(
          organisationVoiceSettings.organisationId,
          launchScenario.organisationId
        )
      );
    return settings?.enabled ?? false;
  } finally {
    await client.pool.end();
  }
}

export async function simulateWrongPersonVoiceOutcome(): Promise<void> {
  const client = createDatabase(databaseUrl);
  const now = new Date();
  try {
    const [call] = await client.db
      .select()
      .from(voiceCallRequests)
      .where(
        and(
          eq(voiceCallRequests.organisationId, launchScenario.organisationId),
          eq(voiceCallRequests.contactId, launchScenario.contactId)
        )
      )
      .orderBy(desc(voiceCallRequests.createdAt))
      .limit(1);
    if (!call) throw new Error('E2E voice call not found');
    await client.db
      .update(voiceCallRequests)
      .set({
        state: 'COMPLETED',
        outcome: 'WRONG_PERSON',
        providerCallId: `call_${randomUUID()}`,
        providerAcceptedAt: now,
        answeredAt: now,
        completedAt: now,
        updatedAt: now
      })
      .where(eq(voiceCallRequests.id, call.id));
    await client.db.insert(voiceCallEvents).values({
      organisationId: launchScenario.organisationId,
      voiceCallId: call.id,
      providerEventKey: randomUUID(),
      eventType: 'VOICE_WRONG_PERSON_REPORTED',
      safeState: 'COMPLETED',
      safeOutcome: 'WRONG_PERSON',
      occurredAt: now
    });
    await client.db
      .insert(suppressions)
      .values({
        organisationId: launchScenario.organisationId,
        channel: 'VOICE',
        normalisedDestination: call.destinationNumber,
        source: 'RETELL_WRONG_PERSON',
        reason: 'Wrong person reported during voice reminder',
        consentState: 'SUPPRESSED',
        recordedAt: now
      })
      .onConflictDoUpdate({
        target: [
          suppressions.organisationId,
          suppressions.channel,
          suppressions.normalisedDestination
        ],
        set: {
          source: 'RETELL_WRONG_PERSON',
          reason: 'Wrong person reported during voice reminder',
          consentState: 'SUPPRESSED',
          recordedAt: now
        }
      });
    await client.db.insert(tasks).values({
      organisationId: launchScenario.organisationId,
      kind: 'VOICE_CONTACT_REVIEW',
      contactId: launchScenario.contactId,
      status: 'OPEN',
      summary: 'Verify the customer phone number before voice reminders resume',
      createdAt: now,
      updatedAt: now
    });
  } finally {
    await client.pool.end();
  }
}

export async function prepareCustomerRolloutScenario(): Promise<void> {
  await seedLaunchScenario(databaseUrl, 'readyForReconciliation');
}

export async function bumpOperationalStateVersion(): Promise<void> {
  const client = createDatabase(databaseUrl);
  try {
    await client.db
      .update(organisations)
      .set({
        operationalStateVersion: sql`${organisations.operationalStateVersion} + 1`
      })
      .where(eq(organisations.id, launchScenario.organisationId));
  } finally {
    await client.pool.end();
  }
}

export async function readRolloutState(): Promise<{
  sendMode: 'dry-run' | 'live';
  rolloutScope: 'CONTROLLED' | 'CUSTOMER';
  operationalState: string;
}> {
  const client = createDatabase(databaseUrl);
  try {
    const [organisation] = await client.db
      .select({
        sendMode: organisations.sendMode,
        rolloutScope: organisations.rolloutScope,
        operationalState: organisations.operationalState
      })
      .from(organisations)
      .where(eq(organisations.id, launchScenario.organisationId))
      .limit(1);
    if (!organisation) throw new Error('E2E organisation not found');
    return organisation;
  } finally {
    await client.pool.end();
  }
}

export async function loginAs(
  page: Page,
  role: 'ADMIN' | 'OPERATOR'
): Promise<void> {
  const cookie = await createSessionCookie(
    {
      cognitoSubject:
        role === 'ADMIN'
          ? launchScenario.adminSubject
          : launchScenario.operatorSubject
    },
    { secret: sessionSecret }
  );
  const token = decodeURIComponent(
    cookie.slice(cookie.indexOf('=') + 1, cookie.indexOf(';'))
  );
  await page.context().addCookies([
    {
      name: 'bc5000_session',
      value: token,
      domain: '127.0.0.1',
      path: '/',
      httpOnly: true,
      secure: false,
      sameSite: 'Lax'
    }
  ]);
}

export { launchScenario };
