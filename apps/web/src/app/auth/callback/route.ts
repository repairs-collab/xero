import { type NextRequest, NextResponse } from 'next/server';

import {
  clearCognitoTransactionCookie,
  createSessionCookie,
  exchangeCognitoCode,
  readCognitoTransaction
} from '@bc5000/auth';

import {
  getCognitoConfiguration,
  getSessionSecret
} from '../../../server/runtime.js';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const code = request.nextUrl.searchParams.get('code');
  const returnedState = request.nextUrl.searchParams.get('state');
  if (code === null || returnedState === null) {
    return new NextResponse('Invalid callback', { status: 400 });
  }
  const secret = getSessionSecret();
  const transaction = await readCognitoTransaction(request, secret);
  const identity = await exchangeCognitoCode(
    { code, returnedState, transaction },
    getCognitoConfiguration()
  );
  const response = NextResponse.redirect(
    new URL(transaction.returnTo ?? '/', request.url),
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
