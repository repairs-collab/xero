import { type NextRequest, NextResponse } from 'next/server';

import {
  getXeroOAuthService,
  requireWebIdentitySession,
  requireWebSession
} from '../../../server/runtime.js';

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (request.nextUrl.searchParams.get('purpose') === 'solo') {
    try {
      const session = await requireWebIdentitySession(request);
      const result = await getXeroOAuthService().startSoloConnection(session);
      return NextResponse.redirect(result.authorizationUrl, 303);
    } catch {
      return new NextResponse('Unable to start Xero connection', {
        status: 400
      });
    }
  }
  const organisationId = request.nextUrl.searchParams.get('organisationId');
  if (organisationId === null || organisationId.trim() === '') {
    return new NextResponse('Organisation is required', { status: 400 });
  }
  try {
    const session = await requireWebSession(request);
    const result = await getXeroOAuthService().startConnection(session, {
      organisationId,
      returnPath:
        request.nextUrl.searchParams.get('returnTo') ??
        '/settings/integrations'
    });
    return NextResponse.redirect(result.authorizationUrl, 303);
  } catch (error) {
    if (error instanceof Error && error.message === 'FORBIDDEN') {
      return new NextResponse('Forbidden', { status: 403 });
    }
    return new NextResponse('Unable to start Xero connection', {
      status: 400
    });
  }
}
