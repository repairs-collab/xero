import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';

import { requireWebSession } from '../../../server/runtime.js';

export default async function AdminSettingsLayout({
  children
}: {
  children: ReactNode;
}) {
  const session = await requireWebSession(
    new Request('http://localhost/', { headers: await headers() })
  );
  if (session.memberships[0]?.role !== 'ADMIN') redirect('/');
  return children;
}
