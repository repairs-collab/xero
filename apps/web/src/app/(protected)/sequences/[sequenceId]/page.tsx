import { and, asc, desc, eq } from 'drizzle-orm';
import { headers } from 'next/headers';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import {
  organisations,
  reminderSequences,
  reminderSequenceVersions,
  sequenceStages
} from '@bc5000/db/web';
import { debtContactScheduleWindow } from '@bc5000/domain';

import { SequenceEditor } from '../../../../components/sequence-editor.js';
import { getDatabaseClient, requireWebSession } from '../../../../server/runtime.js';
import { loadActiveSmsSchedule } from '../sequence-service.js';
import { getSmsScheduleIssue } from '../sms-schedule.js';

export default async function SequenceDetailPage({
  params
}: {
  params: Promise<{ sequenceId: string }>;
}) {
  const { sequenceId } = await params;
  const session = await requireWebSession(
    new Request('http://localhost/', { headers: await headers() })
  );
  const membership = session.memberships.find((candidate) => candidate.active);
  if (membership === undefined) {
    throw new Error('No active organisation membership');
  }
  const database = getDatabaseClient().db;
  const [sequence] = await database
    .select({
      id: reminderSequences.id,
      kind: reminderSequences.kind,
      name: reminderSequences.name,
      mode: reminderSequences.mode,
      enabled: reminderSequences.enabled,
      timeZone: organisations.timeZone
    })
    .from(reminderSequences)
    .innerJoin(organisations, eq(organisations.id, reminderSequences.organisationId))
    .where(
      and(
        eq(reminderSequences.organisationId, membership.organisationId),
        eq(reminderSequences.id, sequenceId)
      )
    )
    .limit(1);
  if (sequence === undefined) notFound();
  const smsContactWindow = sequence.kind === 'MESSAGING'
    ? debtContactScheduleWindow(sequence.timeZone, new Date())
    : null;
  const currentSmsSchedule = sequence.kind === 'MESSAGING' && sequence.mode === 'AUTOMATIC'
    ? await loadActiveSmsSchedule(database, {
        organisationId: membership.organisationId,
        sequenceId: sequence.id
      })
    : undefined;
  const publishedSmsIssue = currentSmsSchedule
    ? getSmsScheduleIssue(currentSmsSchedule, smsContactWindow)
    : null;

  const [version] = await database
    .select()
    .from(reminderSequenceVersions)
    .where(
      and(
        eq(
          reminderSequenceVersions.organisationId,
          membership.organisationId
        ),
        eq(reminderSequenceVersions.sequenceId, sequenceId)
      )
    )
    .orderBy(desc(reminderSequenceVersions.versionNumber))
    .limit(1);
  const rows = version
    ? await database
        .select()
        .from(sequenceStages)
        .where(eq(sequenceStages.sequenceVersionId, version.id))
        .orderBy(asc(sequenceStages.offsetDays), asc(sequenceStages.createdAt))
    : [];
  const grouped = new Map<
    string,
    {
      key: string;
      offsetDays: number;
      channels: (typeof rows)[number]['channel'][];
      template?: string;
    }
  >();
  for (const row of rows) {
    const current = grouped.get(row.stageKey) ?? {
      key: row.stageKey,
      offsetDays: row.offsetDays,
      channels: [],
      ...(row.template ? { template: row.template } : {})
    };
    current.channels.push(row.channel);
    if (row.template && !current.template) current.template = row.template;
    grouped.set(row.stageKey, current);
  }
  const configuration =
    typeof version?.configuration === 'object' &&
    version.configuration !== null &&
    !Array.isArray(version.configuration)
      ? version.configuration
      : {};
  const allowedCurrencies = Array.isArray(configuration.allowedCurrencies)
    ? configuration.allowedCurrencies.filter(
        (value): value is string => typeof value === 'string'
      )
    : ['AUD'];
  const maxCallsPerRun =
    typeof configuration.maxCallsPerRun === 'number'
      ? configuration.maxCallsPerRun
      : 5;
  const cooldownSeconds =
    typeof configuration.cooldownSeconds === 'number'
      ? configuration.cooldownSeconds
      : 120;
  const tab = sequence.kind === 'VOICE' ? 'voice' : 'messaging';

  return (
    <div className="page-stack">
      <header className="page-heading">
        <span className="eyebrow">Sequence editor</span>
        <h1>{sequence.name}</h1>
        <p>Changes stay in draft until you activate a new locked version.</p>
        <Link href={`/sequences?tab=${tab}`}>← Back to {tab} sequences</Link>
      </header>
      <nav className="segmented-control" aria-label="Sequence type">
        <Link
          href={
            tab === 'messaging'
              ? `/sequences/${sequence.id}?tab=messaging`
              : '/sequences?tab=messaging'
          }
          className={tab === 'messaging' ? 'is-active' : ''}
          aria-current={tab === 'messaging' ? 'page' : undefined}
        >
          SMS &amp; Email Sequences
        </Link>
        <Link
          href={
            tab === 'voice'
              ? `/sequences/${sequence.id}?tab=voice`
              : '/sequences?tab=voice'
          }
          className={tab === 'voice' ? 'is-active' : ''}
          aria-current={tab === 'voice' ? 'page' : undefined}
        >
          Voice Reminder Sequences
        </Link>
      </nav>
      <SequenceEditor
        organisationId={membership.organisationId}
        sequenceId={sequence.id}
        kind={sequence.kind}
        mode={sequence.mode}
        enabled={sequence.enabled}
        role={membership.role}
        timeZone={sequence.timeZone}
        smsContactWindow={smsContactWindow}
        publishedSmsWarning={currentSmsSchedule && publishedSmsIssue
          ? { issue: publishedSmsIssue, sendTime: currentSmsSchedule.sendTime.slice(0, 5) }
          : null}
        initial={{
          dailyBasis: version?.dailyBasis ?? 'BUSINESS_DAYS',
          smsAggregation:
            version?.smsAggregation ?? 'CONSOLIDATED_CUSTOMER',
          sendTime: (version?.sendTime ?? '09:00').slice(0, 5),
          socialWindowStart: (version?.socialWindowStart ?? '08:00').slice(
            0,
            5
          ),
          socialWindowEnd: (version?.socialWindowEnd ?? '18:00').slice(0, 5),
          minimumBalance: version?.minimumBalance ?? '0',
          maxSmsSegments: version?.maxSmsSegments ?? 3,
          xeroEmailAfterSmsOptOut:
            version?.xeroEmailAfterSmsOptOut ?? true,
          maxCallsPerRun,
          cooldownSeconds,
          allowedCurrencies,
          stages: [...grouped.values()]
        }}
      />
    </div>
  );
}
