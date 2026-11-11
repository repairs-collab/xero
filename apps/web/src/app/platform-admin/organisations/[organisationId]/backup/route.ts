import { NextResponse, type NextRequest } from 'next/server';

import { AuthenticationFailure, AuthorizationFailure } from '@bc5000/auth';

import { getDatabaseClient } from '../../../../../server/runtime.js';
import { isPlatformOwner, requirePlatformOwner } from '../../../../../server/platform-authorization.js';
import { createPlatformCustomerBackupService } from '../../../../../server/platform-customer-backup.js';

const safeFilename = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60) || 'customer';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ organisationId: string }> }
): Promise<NextResponse> {
  try {
    const session = await requirePlatformOwner(request);
    const { organisationId } = await params;
    const service = createPlatformCustomerBackupService({
      verifyOwner: isPlatformOwner,
      database: getDatabaseClient().db,
      clock: { now: () => new Date() }
    });
    const backup = (await service.createBackup(
      session.userId,
      organisationId
    )) as { organisation?: { name?: unknown }; generatedAt?: unknown };
    const name =
      typeof backup.organisation?.name === 'string'
        ? backup.organisation.name
        : 'customer';
    const day = new Date().toISOString().slice(0, 10);
    return new NextResponse(JSON.stringify(backup, null, 2), {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="accountpulse-${safeFilename(name)}-${day}.json"`,
        'Cache-Control': 'no-store, private',
        'X-Content-Type-Options': 'nosniff'
      }
    });
  } catch (error) {
    if (
      error instanceof AuthenticationFailure ||
      error instanceof AuthorizationFailure ||
      (error instanceof Error && error.message === 'ORGANISATION_NOT_FOUND')
    ) {
      return new NextResponse('Not found', {
        status: 404,
        headers: { 'Cache-Control': 'no-store, private' }
      });
    }
    throw error;
  }
}
