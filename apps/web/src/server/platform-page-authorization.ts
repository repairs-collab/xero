import { headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';

import {
  AuthenticationFailure,
  AuthorizationFailure,
  type AppSession
} from '@bc5000/auth';

import { requirePlatformOwner } from './platform-authorization.js';

export const requirePlatformOwnerPage = async (
  path = '/platform-admin'
): Promise<AppSession> => {
  try {
    return await requirePlatformOwner(
      new Request(`http://localhost${path}`, { headers: await headers() })
    );
  } catch (error) {
    if (error instanceof AuthenticationFailure) redirect('/auth/login');
    if (error instanceof AuthorizationFailure) notFound();
    throw error;
  }
};
