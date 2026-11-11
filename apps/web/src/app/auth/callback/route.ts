import { type NextRequest, NextResponse } from 'next/server';

import {
  clearCognitoTransactionCookie,
  createSessionCookie,
  exchangeCognitoCode,
  readCognitoTransaction
} from '@bc5000/auth';

import {
  getCognitoConfiguration,
  getDatabaseClient,
  getSessionSecret
} from '../../../server/runtime.js';
import {
  hasCurrentLegalAcceptance,
  safeLocalReturnTo
} from '../../../server/legal-acceptance.js';
import {
  ensureSelfServiceIdentity,
  SelfServiceIdentityConflict
} from '../../../server/self-service-identity.js';
import { acceptPendingInvitations } from '../../(protected)/settings/users/user-administration.js';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const code = request.nextUrl.searchParams.get('code');
  const returnedState = request.nextUrl.searchParams.get('state');
  if (code === null || returnedState === null) {
    return new NextResponse('Invalid callback', { status: 400 });
  }
  const secret = getSessionSecret();
  const configuration = getCognitoConfiguration();
  const transaction = await readCognitoTransaction(request, secret);
  const identity = await exchangeCognitoCode(
    { code, returnedState, transaction },
    configuration
  );
  const database = getDatabaseClient().db;
  let applicationIdentity: Awaited<ReturnType<typeof ensureSelfServiceIdentity>>;
  try {
    applicationIdentity = await ensureSelfServiceIdentity(database, identity);
  } catch (error) {
    if (!(error instanceof SelfServiceIdentityConflict)) throw error;
    const recovery = new URL('/account-recovery', configuration.redirectUri);
    recovery.searchParams.set('reason', 'identity-conflict');
    const response = NextResponse.redirect(recovery, 303);
    response.headers.append('Set-Cookie', clearCognitoTransactionCookie());
    return response;
  }
  await acceptPendingInvitations(database, identity.subject, new Date());
  const requestedReturnTo = safeLocalReturnTo(transaction.returnTo, '/');
  const returnTo = await hasCurrentLegalAcceptance(
    database,
    applicationIdentity.userId
  )
    ? requestedReturnTo
    : `/account/accept-terms?returnTo=${encodeURIComponent(requestedReturnTo)}`;
  const response = NextResponse.redirect(
    new URL(returnTo, configuration.redirectUri),
    303
  );
  response.headers.append(
    'Set-Cookie',
    await createSessionCookie(
      { cognitoSubject: identity.subject },
      { secret }
    )
  );
  response.headers.append('Set-Cookie', clearCognitoTransactionCookie());
  return response;
}
