import { type NextRequest, NextResponse } from 'next/server';

import {
  createCognitoAuthorizationRequest,
  createCognitoTransactionCookie
} from '@bc5000/auth';

import { isPublicSignupEnabled } from '../../../server/public-signup.js';
import {
  getCognitoConfiguration,
  getSessionSecret
} from '../../../server/runtime.js';

const safeReturnTo = (value: string | null): string =>
  value !== null && value.startsWith('/') && !value.startsWith('//')
    ? value
    : '/';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const signUp = request.nextUrl.searchParams.get('mode') === 'signup';
  const configuration = getCognitoConfiguration();
  if (signUp && !isPublicSignupEnabled()) {
    return NextResponse.redirect(new URL('/start', configuration.redirectUri), 303);
  }
  const login = createCognitoAuthorizationRequest(
    configuration,
    {
      returnTo: signUp
        ? '/onboarding'
        : safeReturnTo(request.nextUrl.searchParams.get('returnTo')),
      ...(signUp ? { mode: 'signup' as const } : {})
    }
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
