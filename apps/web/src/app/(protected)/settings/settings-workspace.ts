import { eq } from 'drizzle-orm';

import { organisations, type Database, type OrganisationEdition } from '@bc5000/db/web';

export async function loadSettingsWorkspaceEdition(
  database: Database,
  organisationId: string
): Promise<OrganisationEdition> {
  const [organisation] = await database
    .select({ edition: organisations.edition })
    .from(organisations)
    .where(eq(organisations.id, organisationId))
    .limit(1);
  if (organisation === undefined) throw new Error('Organisation not found');
  return organisation.edition;
}
