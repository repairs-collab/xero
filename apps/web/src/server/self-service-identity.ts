import { eq, sql } from 'drizzle-orm';

import { type Database, users } from '@bc5000/db/web';

export interface SelfServiceIdentityInput {
  subject: string;
  email: string;
  name?: string;
}

export interface SelfServiceIdentityResult {
  userId: string;
  created: boolean;
}

export class SelfServiceIdentityConflict extends Error {
  readonly code = 'SELF_SERVICE_IDENTITY_CONFLICT';

  constructor() {
    super('SELF_SERVICE_IDENTITY_CONFLICT');
    this.name = 'SelfServiceIdentityConflict';
  }
}

const normaliseEmail = (email: string): string => email.trim().toLowerCase();

const displayNameFor = (identity: SelfServiceIdentityInput): string => {
  const name = identity.name?.trim();
  return name === undefined || name === '' ? normaliseEmail(identity.email) : name;
};

export async function ensureSelfServiceIdentity(
  database: Database,
  identity: SelfServiceIdentityInput
): Promise<SelfServiceIdentityResult> {
  const email = normaliseEmail(identity.email);
  const displayName = displayNameFor(identity);
  if (identity.subject.trim() === '' || email === '') {
    throw new SelfServiceIdentityConflict();
  }

  return database.transaction(async (transaction) => {
    const [subjectOwner] = await transaction
      .select()
      .from(users)
      .where(eq(users.cognitoSubject, identity.subject));
    const [emailOwner] = await transaction
      .select()
      .from(users)
      .where(sql`lower(${users.email}) = ${email}`);

    if (
      subjectOwner !== undefined &&
      subjectOwner.disabledAt === null &&
      (emailOwner === undefined || emailOwner.id === subjectOwner.id)
    ) {
      const [updated] = await transaction
        .update(users)
        .set({ email, displayName })
        .where(eq(users.id, subjectOwner.id))
        .returning({ id: users.id });
      if (updated === undefined) throw new SelfServiceIdentityConflict();
      return { userId: updated.id, created: false };
    }
    if (subjectOwner !== undefined || emailOwner !== undefined) {
      throw new SelfServiceIdentityConflict();
    }

    const [created] = await transaction
      .insert(users)
      .values({
        cognitoSubject: identity.subject,
        email,
        displayName
      })
      .onConflictDoNothing()
      .returning({ id: users.id });
    if (created !== undefined) return { userId: created.id, created: true };

    const [concurrentSubjectOwner] = await transaction
      .select()
      .from(users)
      .where(eq(users.cognitoSubject, identity.subject));
    const [concurrentEmailOwner] = await transaction
      .select()
      .from(users)
      .where(sql`lower(${users.email}) = ${email}`);
    if (
      concurrentSubjectOwner === undefined ||
      concurrentSubjectOwner.disabledAt !== null ||
      concurrentEmailOwner?.id !== concurrentSubjectOwner.id
    ) {
      throw new SelfServiceIdentityConflict();
    }
    return { userId: concurrentSubjectOwner.id, created: false };
  });
}
