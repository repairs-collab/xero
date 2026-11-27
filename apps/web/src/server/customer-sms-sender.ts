import { and, eq, inArray } from 'drizzle-orm';

import { type Database, organisations, smsNumberPool } from '@bc5000/db/web';

export async function loadCustomerSmsSender(
  database: Database,
  organisationId: string
) {
  const [workspace] = await database
    .select({
      timeZone: organisations.timeZone,
      sharedSenderLinkedAt: organisations.sinchSharedAccountLinkedAt,
      number: {
        e164Number: smsNumberPool.e164Number,
        status: smsNumberPool.status
      }
    })
    .from(organisations)
    .leftJoin(smsNumberPool, and(
      eq(smsNumberPool.organisationId, organisations.id),
      inArray(smsNumberPool.status, ['RESERVED', 'READY', 'QUARANTINED'])
    ))
    .where(eq(organisations.id, organisationId))
    .limit(1);
  if (!workspace) throw new Error('Organisation not found');
  return {
    timeZone: workspace.timeZone,
    number: workspace.number,
    sharedSmsReady: workspace.sharedSenderLinkedAt !== null &&
      workspace.sharedSenderLinkedAt.getTime() <= Date.now()
  };
}
