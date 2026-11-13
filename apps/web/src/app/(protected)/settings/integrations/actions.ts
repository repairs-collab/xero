'use server';

import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';

import { getJobQueue } from '../../../../server/job-runtime.js';
import {
  getDatabaseClient,
  getXeroOAuthService,
  requireWebAcceptedSession
} from '../../../../server/runtime.js';
import { createIntegrationSettings } from './integration-settings.js';

const text = (formData: FormData, name: string) => {
  const value = formData.get(name);
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} is required`);
  }
  return value;
};

async function context() {
  const session = await requireWebAcceptedSession(
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
  return { session, settings };
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

export async function disconnectXero(formData: FormData): Promise<void> {
  const { session } = await context();
  await getXeroOAuthService().disconnect(
    session,
    text(formData, 'organisationId')
  );
  revalidatePath('/settings/integrations');
}
