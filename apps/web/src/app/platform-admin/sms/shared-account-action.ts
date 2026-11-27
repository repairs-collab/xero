'use server';

import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { requirePlatformOwner } from '../../../server/platform-authorization.js';
import { linkPlatformSinchAccount } from '../../../server/platform-sinch-account.js';
import { getDatabaseClient } from '../../../server/runtime.js';

export async function linkSharedSinchAccount(formData: FormData): Promise<void> {
  const session = await requirePlatformOwner(new Request('http://localhost/platform-admin/sms', {
    headers: await headers()
  }));
  const company = formData.get('organisationId');
  const subAccount = formData.get('accountId');
  const outcome = await linkPlatformSinchAccount(getDatabaseClient().db, session.userId, {
    organisationId: typeof company === 'string' ? company : '',
    accountId: typeof subAccount === 'string' ? subAccount.trim() : '',
    confirmed: formData.get('sharedPoolConfirmed') === 'on',
    now: new Date()
  });
  revalidatePath('/platform-admin/sms');
  redirect(`/platform-admin/sms?sharedAccountResult=${outcome}`);
}
