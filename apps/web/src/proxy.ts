import { type NextRequest, NextResponse } from 'next/server';

import { evaluateProxyAccess } from './proxy-policy.js';

export function proxy(request: NextRequest): NextResponse {
  const decision = evaluateProxyAccess(
    request.nextUrl.pathname,
    request.cookies.has('bc5000_session')
  );
  if (decision === 'allow') return NextResponse.next();
  const login = new URL('/auth/login', request.url);
  login.searchParams.set(
    'returnTo',
    `${request.nextUrl.pathname}${request.nextUrl.search}`
  );
  return NextResponse.redirect(login);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|.*\\.(?:png|jpg|jpeg|gif|svg|ico)$).*)']
};
