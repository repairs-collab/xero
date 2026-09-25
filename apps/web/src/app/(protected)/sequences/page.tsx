import { and, desc, eq } from 'drizzle-orm';
import { headers } from 'next/headers';
import Link from 'next/link';

import { reminderSequences, reminderSequenceVersions } from '@bc5000/db/web';

import { getDatabaseClient, requireWebSession } from '../../../server/runtime.js';
import { createStandardSequence } from './actions.js';

export default async function SequencesPage() {
  const session = await requireWebSession(new Request('http://localhost/', { headers: await headers() }));
  const membership = session.memberships.find((candidate) => candidate.active);
  if (membership === undefined) throw new Error('No active organisation membership');
  const organisationId = membership.organisationId;
  const rows = await getDatabaseClient().db.select({ sequence: reminderSequences, version: reminderSequenceVersions }).from(reminderSequences).leftJoin(reminderSequenceVersions, and(eq(reminderSequenceVersions.sequenceId, reminderSequences.id), eq(reminderSequenceVersions.status, 'ACTIVE'))).where(eq(reminderSequences.organisationId, organisationId)).orderBy(desc(reminderSequences.updatedAt));
  return <div className="page-stack"><header className="page-heading"><span className="eyebrow">Automation</span><h1>Sequences</h1><p>Start in review mode, then automate only the sequences you trust.</p></header>{rows.length === 0 ? <section className="panel"><span className="eyebrow">Safe starter</span><h2>{membership.role === 'ADMIN' ? 'Create the standard review sequence' : 'Standard review sequence not created'}</h2><p>{membership.role === 'ADMIN' ? 'Creates the approved due-date, 7-day, 21-day and 30-day journey. Every reminder remains in review-and-approve mode.' : 'An administrator can create the approved reminder journey. It will remain in review-and-approve mode.'}</p>{membership.role === 'ADMIN' ? <form action={createStandardSequence}><input type="hidden" name="organisationId" value={organisationId} /><button className="button button--primary">Create standard review sequence</button></form> : null}</section> : <div className="sequence-cards">{rows.map(({ sequence, version }) => <Link href={`/sequences/${sequence.id}`} className="sequence-card" key={sequence.id}><div><span className={`mode-badge mode-badge--${sequence.mode.toLowerCase()}`}>{sequence.mode === 'REVIEW' ? 'Review and approve' : 'Automatic'}</span><h2>{sequence.name}</h2><p>{version ? `Active version ${version.versionNumber}` : 'No active version'} · {version?.dailyBasis === 'CALENDAR_DAYS' ? 'Calendar days' : 'Business days'}</p></div><span className="sequence-card__arrow">›</span></Link>)}</div>}</div>;
}
