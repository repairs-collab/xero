import { type NextRequest, NextResponse } from 'next/server';

import { clearSessionCookie } from '@bc5000/auth';

export function GET(request: NextRequest): NextResponse {
  const response = NextResponse.redirect(new URL('/auth/login', request.url));
  response.headers.append('Set-Cookie', clearSessionCookie());
  return response;
}
