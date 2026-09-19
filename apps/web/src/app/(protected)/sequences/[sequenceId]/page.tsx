import { and, asc, desc, eq } from 'drizzle-orm';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';

import { reminderSequences, reminderSequenceVersions, sequenceStages } from '@bc5000/db/web';

import { SequenceEditor } from '../../../../components/sequence-editor.js';
import { getDatabaseClient, requireWebSession } from '../../../../server/runtime.js';

export default async function SequenceDetailPage({ params }: { params: Promise<{ sequenceId: string }> }) {
  const { sequenceId } = await params;
  const session = await requireWebSession(new Request('http://localhost/', { headers: await headers() }));
  const membership = session.memberships[0];
  if (membership === undefined) throw new Error('No active organisation membership');
  const [sequence] = await getDatabaseClient().db.select().from(reminderSequences).where(and(eq(reminderSequences.organisationId, membership.organisationId), eq(reminderSequences.id, sequenceId))).limit(1);
  if (sequence === undefined) notFound();
  const [version] = await getDatabaseClient().db.select().from(reminderSequenceVersions).where(and(eq(reminderSequenceVersions.organisationId, membership.organisationId), eq(reminderSequenceVersions.sequenceId, sequenceId))).orderBy(desc(reminderSequenceVersions.versionNumber)).limit(1);
  const rows = version ? await getDatabaseClient().db.select().from(sequenceStages).where(eq(sequenceStages.sequenceVersionId, version.id)).orderBy(asc(sequenceStages.offsetDays), asc(sequenceStages.createdAt)) : [];
  const grouped = new Map<string, { key: string; offsetDays: number; channels: typeof rows[number]['channel'][]; template?: string }>();
  for (const row of rows) { const current = grouped.get(row.stageKey) ?? { key: row.stageKey, offsetDays: row.offsetDays, channels: [], ...(row.template ? { template: row.template } : {}) }; current.channels.push(row.channel); if (row.template && !current.template) current.template = row.template; grouped.set(row.stageKey, current); }
  const stages = [...grouped.values()];
  return <div className="page-stack"><header className="page-heading"><span className="eyebrow">Sequence editor</span><h1>{sequence.name}</h1><p>Changes stay in draft until you activate a new immutable version.</p></header><SequenceEditor organisationId={membership.organisationId} sequenceId={sequence.id} mode={sequence.mode} role={membership.role} initial={{ dailyBasis: version?.dailyBasis ?? 'BUSINESS_DAYS', smsAggregation: version?.smsAggregation ?? 'CONSOLIDATED_CUSTOMER', sendTime: (version?.sendTime ?? '09:00').slice(0,5), socialWindowStart: (version?.socialWindowStart ?? '08:00').slice(0,5), socialWindowEnd: (version?.socialWindowEnd ?? '18:00').slice(0,5), minimumBalance: version?.minimumBalance ?? '0', maxSmsSegments: version?.maxSmsSegments ?? 3, xeroEmailAfterSmsOptOut: version?.xeroEmailAfterSmsOptOut ?? true, allowedCurrencies: Array.isArray(version?.configuration.allowedCurrencies) ? version.configuration.allowedCurrencies.filter((value): value is string => typeof value === 'string') : ['AUD'], stages }} /></div>;
}
