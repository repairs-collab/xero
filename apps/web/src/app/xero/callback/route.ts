import { type NextRequest, NextResponse } from 'next/server';

import {
  getXeroOAuthService,
  requireWebIdentitySession
} from '../../../server/runtime.js';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const state = request.nextUrl.searchParams.get('state');
  if (state === null || state.length === 0) {
    return new NextResponse('Invalid Xero callback', { status: 400 });
  }
  try {
    const session = await requireWebIdentitySession(request);
    const result = await getXeroOAuthService().handleCallback(session, {
      state,
      code: request.nextUrl.searchParams.get('code'),
      error: request.nextUrl.searchParams.get('error')
    });
    const destination =
      result.kind === 'CONNECTED'
        ? result.returnPath
        : result.kind === 'SELECT_SOLO_TENANT'
          ? `/onboarding/select-xero?pending=${encodeURIComponent(result.pendingAuthorisationId)}`
          : `/settings/integrations/xero/select?organisationId=${encodeURIComponent(result.organisationId)}&pending=${encodeURIComponent(result.pendingAuthorisationId)}`;
    return NextResponse.redirect(new URL(destination, request.url), 303);
  } catch (error) {
    if (error instanceof Error && error.message === 'FORBIDDEN') {
      return new NextResponse('Forbidden', { status: 403 });
    }
    return new NextResponse(
      'Xero connection could not be completed. Return to Integrations and try again.',
      { status: 400 }
    );
  }
}
