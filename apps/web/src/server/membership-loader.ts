import { eq } from 'drizzle-orm';

import type { MembershipLoader, MembershipSnapshot } from '@bc5000/auth';
import {
  type Database,
  memberships,
  organisations,
  users
} from '@bc5000/db/web';

type MembershipRow = {
  user: Pick<typeof users.$inferSelect, 'id' | 'displayName' | 'disabledAt'>;
  membership: Pick<
    typeof memberships.$inferSelect,
    'organisationId' | 'role' | 'disabledAt'
  > | null;
  organisationStatus: 'ACTIVE' | 'SUSPENDED' | null;
};

export const membershipSnapshotFromRows = (
  rows: readonly MembershipRow[]
): MembershipSnapshot | null => {
  const first = rows[0];
  if (first === undefined) return null;
  return {
    userId: first.user.id,
    displayName: first.user.displayName,
    active: first.user.disabledAt === null,
    memberships: rows.flatMap((row) =>
      row.membership === null || row.organisationStatus === null
        ? []
        : [
            {
              organisationId: row.membership.organisationId,
              role: row.membership.role,
              active: row.membership.disabledAt === null,
              organisationStatus: row.organisationStatus
            }
          ]
    )
  };
};

export class PostgresMembershipLoader implements MembershipLoader {
  constructor(private readonly database: Database) {}

  async loadForSubject(
    subject: string
  ): Promise<MembershipSnapshot | null> {
    const rows = await this.database
      .select({
        user: users,
        membership: memberships,
        organisationStatus: organisations.platformStatus
      })
      .from(users)
      .leftJoin(memberships, eq(memberships.userId, users.id))
      .leftJoin(
        organisations,
        eq(organisations.id, memberships.organisationId)
      )
      .where(eq(users.cognitoSubject, subject));
    return membershipSnapshotFromRows(rows);
  }
}
