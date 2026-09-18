import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';

import { AuthenticationFailure } from '@bc5000/auth';

import { requireWebSession } from '../../server/runtime.js';

export default async function ProtectedLayout({
  children
}: {
  children: ReactNode;
}) {
  try {
    await requireWebSession(
      new Request('http://localhost/', { headers: await headers() })
    );
  } catch (error) {
    if (error instanceof AuthenticationFailure) redirect('/auth/login');
    throw error;
  }
  return <>{children}</>;
}
