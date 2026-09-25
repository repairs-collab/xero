'use server';

import { and, eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';

import { authorise } from '@bc5000/auth';
import { auditEvents, providerConnections } from '@bc5000/db/web';
import { jobNames } from '@bc5000/jobs';

import { getJobQueue } from '../../../../server/job-runtime.js';
import {
  getDatabaseClient,
  requireWebSession
} from '../../../../server/runtime.js';
import { createIntegrationSettings } from './integration-settings.js';

const text = (formData: FormData, name: string) => {
  const value = formData.get(name);
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} is required`);
  }
  return value;
};

const provider = (formData: FormData) => {
  const value = text(formData, 'provider');
  if (value !== 'XERO' && value !== 'SINCH') {
    throw new Error('Invalid provider');
  }
  return value;
};

async function context() {
  const session = await requireWebSession(
    new Request('http://localhost/', { headers: await headers() })
  );
  const database = getDatabaseClient().db;
  const settings = createIntegrationSettings({
    database,
    publisher: await getJobQueue(),
    tester: {
      test: () => Promise.reject(new Error('Connection tests run in the worker'))
    },
    clock: { now: () => new Date() }
  });
  return { database, session, settings };
}

export async function replaceSecretReference(
  formData: FormData
): Promise<void> {
  const { session, settings } = await context();
  await settings.replaceSecretReference(session, {
    organisationId: text(formData, 'organisationId'),
    provider: provider(formData),
    secretArn: text(formData, 'secretArn')
  });
  revalidatePath('/settings/integrations');
}

export async function rotateCallbackKeyReference(
  formData: FormData
): Promise<void> {
  const { session, settings } = await context();
  await settings.rotateCallbackKeyReference(session, {
    organisationId: text(formData, 'organisationId'),
    keyId: text(formData, 'keyId')
  });
  revalidatePath('/settings/integrations');
}

export async function testConnection(formData: FormData): Promise<void> {
  const { database, session } = await context();
  const organisationId = text(formData, 'organisationId');
  const selectedProvider = provider(formData);
  authorise(session, 'provider.configure', organisationId);
  const [connection] = await database
    .select({ id: providerConnections.id })
    .from(providerConnections)
    .where(
      and(
        eq(providerConnections.organisationId, organisationId),
        eq(providerConnections.provider, selectedProvider)
      )
    )
    .limit(1);
  if (!connection) throw new Error('PROVIDER_CONNECTION_NOT_FOUND');

  const queue = await getJobQueue();
  const now = new Date();
  await queue.publish(
    jobNames.providerConnectionTest,
    { organisationId, provider: selectedProvider },
    {
      singletonKey: `provider-test:${organisationId}:${selectedProvider}:${now.toISOString()}`
    }
  );
  await database.insert(auditEvents).values({
    organisationId,
    actorUserId: session.userId,
    eventType: 'PROVIDER_CONNECTION_TEST_REQUESTED',
    entityType: 'PROVIDER_CONNECTION',
    entityId: connection.id,
    afterValue: { provider: selectedProvider },
    occurredAt: now
  });
  revalidatePath('/settings/integrations');
}

export async function requestXeroSync(formData: FormData): Promise<void> {
  const { session, settings } = await context();
  await settings.requestXeroSync(session, {
    organisationId: text(formData, 'organisationId')
  });
  revalidatePath('/');
  revalidatePath('/settings/integrations');
  revalidatePath('/settings/sending');
}
