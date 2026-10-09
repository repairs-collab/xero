import { and, desc, eq } from 'drizzle-orm';
import { headers } from 'next/headers';

import {
  reminderSequences,
  reminderSequenceVersions
} from '@bc5000/db/web';

import { SequenceTabs } from '../../../components/sequence-tabs.js';
import { getDatabaseClient, requireWebSession } from '../../../server/runtime.js';
import {
  createStandardSequence,
  createStandardVoiceSequence
} from './actions.js';

export default async function SequencesPage({
  searchParams
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const query = await searchParams;
  const activeTab = query.tab === 'voice' ? 'voice' : 'messaging';
  const session = await requireWebSession(
    new Request('http://localhost/', { headers: await headers() })
  );
  const membership = session.memberships.find((candidate) => candidate.active);
  if (membership === undefined) {
    throw new Error('No active organisation membership');
  }
  const organisationId = membership.organisationId;
  const rows = await getDatabaseClient()
    .db.select({
      sequence: reminderSequences,
      version: reminderSequenceVersions
    })
    .from(reminderSequences)
    .leftJoin(
      reminderSequenceVersions,
      and(
        eq(reminderSequenceVersions.sequenceId, reminderSequences.id),
        eq(reminderSequenceVersions.status, 'ACTIVE')
      )
    )
    .where(eq(reminderSequences.organisationId, organisationId))
    .orderBy(desc(reminderSequences.updatedAt));

  return (
    <div className="page-stack">
      <header className="page-heading">
        <span className="eyebrow">Automation</span>
        <h1>Sequences</h1>
        <p>
          Schedule messaging and voice reminders independently, then automate
          only the sequences you trust.
        </p>
      </header>
      <SequenceTabs
        activeTab={activeTab}
        organisationId={organisationId}
        role={membership.role}
        rows={rows.map(({ sequence, version }) => ({
          id: sequence.id,
          name: sequence.name,
          kind: sequence.kind,
          mode: sequence.mode,
          enabled: sequence.enabled,
          versionNumber: version?.versionNumber ?? null,
          dailyBasis: version?.dailyBasis ?? null
        }))}
        createMessagingAction={createStandardSequence}
        createVoiceAction={createStandardVoiceSequence}
      />
    </div>
  );
}
