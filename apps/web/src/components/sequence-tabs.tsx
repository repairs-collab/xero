import { ChevronRightIcon } from '@heroicons/react/24/outline';
import Link from 'next/link';

import type { SequenceKind } from '@bc5000/db/web';
import type { DailyBasis } from '@bc5000/domain';

type ActiveTab = 'messaging' | 'voice';

export interface SequenceTabRow {
  id: string;
  name: string;
  kind: SequenceKind;
  mode: 'REVIEW' | 'AUTOMATIC';
  enabled: boolean;
  versionNumber: number | null;
  dailyBasis: DailyBasis | null;
}

interface SequenceTabsProps {
  activeTab: ActiveTab;
  organisationId: string;
  role: 'ADMIN' | 'OPERATOR';
  rows: SequenceTabRow[];
  createMessagingAction: (formData: FormData) => Promise<void>;
  createVoiceAction: (formData: FormData) => Promise<void>;
}

export function SequenceTabs({
  activeTab,
  organisationId,
  role,
  rows,
  createMessagingAction,
  createVoiceAction
}: SequenceTabsProps) {
  const kind = activeTab === 'voice' ? 'VOICE' : 'MESSAGING';
  const visibleRows = rows.filter((row) => row.kind === kind);
  const isVoice = activeTab === 'voice';
  const createAction = isVoice ? createVoiceAction : createMessagingAction;

  return (
    <>
      <nav className="segmented-control" aria-label="Sequence type">
        <Link
          href="/sequences?tab=messaging"
          className={activeTab === 'messaging' ? 'is-active' : ''}
        >
          SMS &amp; Email Sequences
        </Link>
        <Link
          href="/sequences?tab=voice"
          className={activeTab === 'voice' ? 'is-active' : ''}
        >
          Voice Reminder Sequences
        </Link>
      </nav>

      {visibleRows.length === 0 ? (
        <section className="panel">
          <span className="eyebrow">Safe starter</span>
          <h2>
            {role === 'ADMIN'
              ? isVoice
                ? 'Create the standard voice reminder sequence'
                : 'Create the standard review sequence'
              : isVoice
                ? 'Voice reminder sequence not created'
                : 'Standard review sequence not created'}
          </h2>
          <p>
            {isVoice
              ? 'Voice calls have their own schedule, stages and enable switch. The starter sequence begins in review mode.'
              : 'Creates the approved due-date, 7-day, 21-day and 30-day journey. Every reminder begins in review mode.'}
          </p>
          {role === 'ADMIN' ? (
            <form action={createAction}>
              <input
                type="hidden"
                name="organisationId"
                value={organisationId}
              />
              <button className="button button--primary">
                {isVoice
                  ? 'Create standard voice sequence'
                  : 'Create standard review sequence'}
              </button>
            </form>
          ) : null}
        </section>
      ) : (
        <div className="sequence-cards">
          {visibleRows.map((row) => (
            <Link
              href={`/sequences/${row.id}?tab=${activeTab}`}
              className="sequence-card"
              key={row.id}
            >
              <div>
                <span
                  className={`mode-badge mode-badge--${row.mode.toLowerCase()}`}
                >
                  {row.mode === 'REVIEW' ? 'Review and approve' : 'Automatic'}
                </span>
                {!row.enabled ? (
                  <span className="mode-badge">Disabled</span>
                ) : null}
                <h2>{row.name}</h2>
                <p>
                  {row.versionNumber === null
                    ? 'No active version'
                    : `Active version ${row.versionNumber}`}{' '}
                  ·{' '}
                  {row.dailyBasis === 'CALENDAR_DAYS'
                    ? 'Calendar days'
                    : 'Business days'}
                </p>
              </div>
              <ChevronRightIcon
                className="sequence-card__arrow"
                aria-hidden="true"
              />
            </Link>
          ))}
        </div>
      )}
    </>
  );
}
