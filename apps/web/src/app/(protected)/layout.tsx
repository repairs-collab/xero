import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { eq } from 'drizzle-orm';

import { AuthenticationFailure } from '@bc5000/auth';
import { organisationOnboarding, organisations } from '@bc5000/db/web';

import {
  getDatabaseClient,
  requireWebSession
} from '../../server/runtime.js';
import { AppShell } from '../../components/app-shell.js';
import { AccountSuspendedBanner } from '../../components/account-suspended-banner.js';
import { isPlatformOwner } from '../../server/platform-authorization.js';

export default async function ProtectedLayout({
  children
}: {
  children: ReactNode;
}) {
  try {
    const session = await requireWebSession(
      new Request('http://localhost/', { headers: await headers() })
    );
    const membership = session.memberships[0];
    if (membership === undefined) redirect('/auth/login');
    const [workspace] = await getDatabaseClient()
      .db.select({
        name: organisations.name,
        edition: organisations.edition,
        platformStatus: organisations.platformStatus,
        completedVersion: organisationOnboarding.completedVersion
      })
      .from(organisations)
      .leftJoin(
        organisationOnboarding,
        eq(organisationOnboarding.organisationId, organisations.id)
      )
      .where(eq(organisations.id, membership.organisationId))
      .limit(1);
    if (workspace === undefined) throw new Error('Organisation not found');
    const platformOwner = await isPlatformOwner(session.userId);
    return (
      <AppShell
        displayName={session.displayName}
        role={membership.role}
        organisationName={workspace.name}
        onboardingIncomplete={
          workspace.edition === 'SOLO' && workspace.completedVersion !== 1
        }
        platformOwner={platformOwner}
      >
        {workspace.platformStatus === 'SUSPENDED' ? (
          <AccountSuspendedBanner />
        ) : null}
        {children}
      </AppShell>
    );
  } catch (error) {
    if (error instanceof AuthenticationFailure) redirect('/auth/login');
    throw error;
  }
}
