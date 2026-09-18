import { eq } from 'drizzle-orm';

import type { MembershipLoader, MembershipSnapshot } from '@bc5000/auth';
import { type Database, memberships, users } from '@bc5000/db/web';

export class PostgresMembershipLoader implements MembershipLoader {
  constructor(private readonly database: Database) {}

  async loadForSubject(
    subject: string
  ): Promise<MembershipSnapshot | null> {
    const rows = await this.database
      .select({ user: users, membership: memberships })
      .from(users)
      .leftJoin(memberships, eq(memberships.userId, users.id))
      .where(eq(users.cognitoSubject, subject));
    const first = rows[0];
    if (first === undefined) return null;
    return {
      userId: first.user.id,
      displayName: first.user.displayName,
      memberships: rows.flatMap((row) =>
        row.membership === null
          ? []
          : [
              {
                organisationId: row.membership.organisationId,
                role: row.membership.role,
                active:
                  first.user.disabledAt === null &&
                  row.membership.disabledAt === null
              }
            ]
      )
    };
  }
}
