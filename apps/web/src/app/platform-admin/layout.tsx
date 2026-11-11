import { headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import type { ReactNode } from 'react';

import {
  AuthenticationFailure,
  AuthorizationFailure
} from '@bc5000/auth';

import { PlatformAdminShell } from '../../components/platform-admin-shell.js';
import { requirePlatformOwner } from '../../server/platform-authorization.js';

export default async function PlatformAdminLayout({
  children
}: {
  children: ReactNode;
}) {
  try {
    const session = await requirePlatformOwner(
      new Request('http://localhost/platform-admin', { headers: await headers() })
    );
    return (
      <PlatformAdminShell displayName={session.displayName}>
        {children}
      </PlatformAdminShell>
    );
  } catch (error) {
    if (error instanceof AuthenticationFailure) redirect('/auth/login');
    if (error instanceof AuthorizationFailure) notFound();
    throw error;
  }
}
