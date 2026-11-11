import { and, eq } from 'drizzle-orm';

import {
  type Database,
  userLegalAcceptances,
  users
} from '@bc5000/db/web';

export const currentLegalVersions = {
  terms: '2026-11-11',
  privacy: '2026-11-11',
  acceptableUse: '2026-11-11'
} as const;

export class LegalAcceptanceRequired extends Error {
  readonly code = 'LEGAL_ACCEPTANCE_REQUIRED';

  constructor() {
    super('LEGAL_ACCEPTANCE_REQUIRED');
    this.name = 'LegalAcceptanceRequired';
  }
}

export async function hasCurrentLegalAcceptance(
  database: Database,
  userId: string
): Promise<boolean> {
  const [user] = await database
    .select({ platformRole: users.platformRole })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (user?.platformRole === 'OWNER') return true;

  const [accepted] = await database
    .select({ id: userLegalAcceptances.id })
    .from(userLegalAcceptances)
    .where(
      and(
        eq(userLegalAcceptances.userId, userId),
        eq(userLegalAcceptances.termsVersion, currentLegalVersions.terms),
        eq(
          userLegalAcceptances.privacyVersion,
          currentLegalVersions.privacy
        ),
        eq(
          userLegalAcceptances.acceptableUseVersion,
          currentLegalVersions.acceptableUse
        )
      )
    )
    .limit(1);
  return accepted !== undefined;
}

export async function recordCurrentLegalAcceptance(
  database: Database,
  input: { userId: string; acceptedAt: Date }
): Promise<void> {
  await database
    .insert(userLegalAcceptances)
    .values({
      userId: input.userId,
      termsVersion: currentLegalVersions.terms,
      privacyVersion: currentLegalVersions.privacy,
      acceptableUseVersion: currentLegalVersions.acceptableUse,
      acceptedAt: input.acceptedAt
    })
    .onConflictDoNothing();
}

export const safeLocalReturnTo = (
  value: string | null | undefined,
  fallback = '/onboarding'
): string =>
  value !== null &&
  value !== undefined &&
  value.startsWith('/') &&
  !value.startsWith('//') &&
  !value.startsWith('/account/accept-terms')
    ? value
    : fallback;
