import { type NextRequest, NextResponse } from 'next/server';

import {
  createCognitoAuthorizationRequest,
  createCognitoTransactionCookie
} from '@bc5000/auth';

import {
  getCognitoConfiguration,
  getSessionSecret
} from '../../../server/runtime.js';

const safeReturnTo = (value: string | null): string =>
  value !== null && value.startsWith('/') && !value.startsWith('//')
    ? value
    : '/';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const login = createCognitoAuthorizationRequest(
    getCognitoConfiguration(),
    { returnTo: safeReturnTo(request.nextUrl.searchParams.get('returnTo')) }
  );
  const response = NextResponse.redirect(login.url);
  response.headers.append(
    'Set-Cookie',
    await createCognitoTransactionCookie(
      login.transaction,
      getSessionSecret()
    )
  );
  return response;
}
