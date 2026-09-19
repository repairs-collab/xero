import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';

import { AuthenticationFailure } from '@bc5000/auth';

import { requireWebSession } from '../../server/runtime.js';
import { AppShell } from '../../components/app-shell.js';

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
    return <AppShell displayName={session.displayName} role={membership.role}>{children}</AppShell>;
  } catch (error) {
    if (error instanceof AuthenticationFailure) redirect('/auth/login');
    throw error;
  }
}
