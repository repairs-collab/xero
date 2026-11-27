'use client';

import { PlusIcon, TrashIcon } from '@heroicons/react/24/outline';
import { useActionState, useState } from 'react';

import type { SequenceKind } from '@bc5000/db/web';
import type { DebtContactScheduleWindow, ReminderStageChannel } from '@bc5000/domain';

import {
  saveSequenceVersion,
  setSequenceEnabled,
  setSequenceMode
} from '../app/(protected)/sequences/actions.js';
import type { SequenceDraftStage } from '../app/(protected)/sequences/sequence-service.js';
import {
  schedulesSms,
  type SequenceScheduleIssue,
  type SmsScheduleIssue
} from '../app/(protected)/sequences/sms-schedule.js';

const messagingChannelOptions: {
  value: ReminderStageChannel;
  label: string;
}[] = [
  { value: 'SMS', label: 'SMS' },
  { value: 'XERO_EMAIL', label: 'Xero email' },
  { value: 'TASK', label: 'Escalation task' },
  { value: 'SMS_DAILY', label: 'Daily SMS thereafter' }
];

const voiceChannelOptions: {
  value: ReminderStageChannel;
  label: string;
}[] = [{ value: 'VOICE', label: 'Automated voice call' }];

interface SequenceEditorInitial {
  dailyBasis: 'BUSINESS_DAYS' | 'CALENDAR_DAYS';
  smsAggregation: 'CONSOLIDATED_CUSTOMER' | 'PER_INVOICE';
  sendTime: string;
  socialWindowStart: string;
  socialWindowEnd: string;
  minimumBalance: string;
  maxSmsSegments: number;
  xeroEmailAfterSmsOptOut: boolean;
  maxCallsPerRun: number;
  cooldownSeconds: number;
  allowedCurrencies: string[];
  stages: SequenceDraftStage[];
}

interface SequenceEditorProps {
  organisationId: string;
  sequenceId: string;
  kind: SequenceKind;
  mode: 'REVIEW' | 'AUTOMATIC';
  enabled: boolean;
  role: 'ADMIN' | 'OPERATOR';
  timeZone: string;
  smsContactWindow: DebtContactScheduleWindow | null;
  publishedSmsWarning: { issue: SmsScheduleIssue; sendTime: string } | null;
  initial: SequenceEditorInitial;
}

const scheduleIssueMessage: Record<SequenceScheduleIssue, string> = {
  INVALID_TIME: 'Enter a valid time for the schedule and both window limits.',
  INVALID_SOCIAL_WINDOW: 'Set the end of the window later than its start.',
  SEND_TIME_OUTSIDE_SOCIAL_WINDOW: 'Set a time at or after the start of your window and before it ends.',
  SMS_SCHEDULE_TIME_ZONE: 'The SMS contact window could not be verified for this workspace time zone.',
  SMS_SCHEDULE_SOCIAL_WINDOW: 'Choose a social window that overlaps the automatic SMS contact hours.',
  SMS_SCHEDULE_SEND_TIME: 'Choose a send time within both the automatic SMS contact hours and your social window.'
};

export function SequenceEditor({
  organisationId,
  sequenceId,
  kind,
  mode,
  enabled,
  role,
  timeZone,
  smsContactWindow,
  publishedSmsWarning,
  initial
}: SequenceEditorProps) {
  const [stages, setStages] = useState(initial.stages);
  const [sendTime, setSendTime] = useState(initial.sendTime);
  const [socialWindowStart, setSocialWindowStart] = useState(initial.socialWindowStart);
  const [socialWindowEnd, setSocialWindowEnd] = useState(initial.socialWindowEnd);
  const [versionIssue, saveVersion] = useActionState(saveSequenceVersion, null);
  const [modeIssue, changeMode] = useActionState(setSequenceMode, null);
  const [enabledIssue, changeEnabled] = useActionState(setSequenceEnabled, null);
  const isVoice = kind === 'VOICE';
  const showSmsHours = !isVoice && (
    publishedSmsWarning !== null || stages.some((stage) => schedulesSms(stage.channels))
  );
  const tab = isVoice ? 'voice' : 'messaging';
  const channelOptions = isVoice
    ? voiceChannelOptions
    : messagingChannelOptions;
  const update = (index: number, patch: Partial<SequenceDraftStage>) =>
    setStages((current) =>
      current.map((stage, stageIndex) =>
        stageIndex === index ? { ...stage, ...patch } : stage
      )
    );
  const toggleChannel = (index: number, channel: ReminderStageChannel) => {
    const stage = stages[index];
    if (stage === undefined) return;
    update(index, {
      channels: stage.channels.includes(channel)
        ? stage.channels.filter((item) => item !== channel)
        : [...stage.channels, channel]
    });
  };
  const addStage = () =>
    setStages((current) => [
      ...current,
      isVoice
        ? {
            key: `voice-stage-${current.length + 1}`,
            offsetDays: 1,
            channels: ['VOICE']
          }
        : {
            key: `stage-${current.length + 1}`,
            offsetDays: 1,
            channels: ['SMS'],
            template:
              'Hi {{customer_name}}, invoice {{invoice_number}} is overdue.'
          }
    ]);

  return (
    <div className="sequence-layout">
      <div>
        <form className="mode-panel" action={changeMode}>
          <input
            type="hidden"
            name="organisationId"
            value={organisationId}
          />
          <input type="hidden" name="sequenceId" value={sequenceId} />
          <div>
            <span className="eyebrow">Delivery mode</span>
            <h2>
              {mode === 'REVIEW' ? 'Review and approve' : 'Automatic'}
            </h2>
            <p>
              {mode === 'REVIEW'
                ? `Every ${isVoice ? 'call' : 'reminder'} waits for a person before sending.`
                : `Eligible ${isVoice ? 'calls' : 'reminders'} run without manual approval.`}
            </p>
            {modeIssue !== null && (
              <p role="alert">{scheduleIssueMessage[modeIssue]} Activate the corrected schedule before switching to automatic.</p>
            )}
          </div>
          <div className="segmented-control">
            <button
              name="mode"
              value="REVIEW"
              className={mode === 'REVIEW' ? 'is-active' : ''}
            >
              Review
            </button>
            <button
              name="mode"
              value="AUTOMATIC"
              disabled={role !== 'ADMIN'}
              title={
                role !== 'ADMIN'
                  ? 'Only Administrators can enable automatic sending'
                  : undefined
              }
              className={mode === 'AUTOMATIC' ? 'is-active' : ''}
            >
              Automatic
            </button>
          </div>
        </form>

        <form className="mode-panel" action={changeEnabled}>
          <input
            type="hidden"
            name="organisationId"
            value={organisationId}
          />
          <input type="hidden" name="sequenceId" value={sequenceId} />
          <input type="hidden" name="enabled" value={String(!enabled)} />
          <div>
            <span className="eyebrow">Sequence status</span>
            <h2>{enabled ? 'Enabled' : 'Disabled'}</h2>
            <p>
              {enabled
                ? `This ${isVoice ? 'voice' : 'messaging'} schedule is active.`
                : `This ${isVoice ? 'voice' : 'messaging'} schedule is paused.`}
            </p>
            {enabledIssue !== null && (
              <p role="alert">{scheduleIssueMessage[enabledIssue]} Activate the corrected schedule before enabling this sequence.</p>
            )}
          </div>
          <button
            className={enabled ? 'button' : 'button button--primary'}
            disabled={role !== 'ADMIN'}
          >
            {enabled ? 'Disable sequence' : 'Enable sequence'}
          </button>
        </form>

        <form className="editor-form" action={saveVersion}>
          <input
            type="hidden"
            name="organisationId"
            value={organisationId}
          />
          <input type="hidden" name="sequenceId" value={sequenceId} />
          <input type="hidden" name="kind" value={kind} />
          <input type="hidden" name="tab" value={tab} />
          <input type="hidden" name="stages" value={JSON.stringify(stages)} />
          <section className="panel editor-section">
            <div className="panel__heading">
              <div>
                <span className="eyebrow">Schedule</span>
                <h2>{isVoice ? 'When calls run' : 'When reminders run'}</h2>
              </div>
            </div>
            {showSmsHours && smsContactWindow !== null && (
              <p id="automatic-sms-hours" className="muted-copy">
                Automatic SMS can start at {smsContactWindow.start} and must start before {smsContactWindow.end} in {timeZone} on eligible business days. Your social window can narrow those hours.
              </p>
            )}
            {publishedSmsWarning !== null && (
              <p role="status">
                The published automatic SMS schedule is set to {publishedSmsWarning.sendTime}. {scheduleIssueMessage[publishedSmsWarning.issue]} Activate a corrected schedule to send at the chosen time.
              </p>
            )}
            {versionIssue !== null && <p role="alert">{scheduleIssueMessage[versionIssue]}</p>}
            <div className="field-grid">
              <label>
                Day counting
                <select name="dailyBasis" defaultValue={initial.dailyBasis}>
                  <option value="BUSINESS_DAYS">Business days</option>
                  <option value="CALENDAR_DAYS">Calendar days</option>
                </select>
              </label>
              <label>
                {isVoice ? 'Call start time' : 'Send time'}
                <input
                  type="time"
                  name="sendTime"
                  aria-describedby={showSmsHours && smsContactWindow !== null ? 'automatic-sms-hours' : undefined}
                  value={sendTime}
                  onChange={(event) => setSendTime(event.target.value)}
                />
              </label>
              <label>
                {isVoice ? 'Calling window starts' : 'Social window starts'}
                <input
                  type="time"
                  name="socialWindowStart"
                  value={socialWindowStart}
                  onChange={(event) => setSocialWindowStart(event.target.value)}
                />
              </label>
              <label>
                {isVoice ? 'Calling window ends' : 'Social window ends'}
                <input
                  type="time"
                  name="socialWindowEnd"
                  value={socialWindowEnd}
                  onChange={(event) => setSocialWindowEnd(event.target.value)}
                />
              </label>
            </div>
          </section>

          <section className="panel editor-section">
            <div className="panel__heading">
              <div>
                <span className="eyebrow">Reminder journey</span>
                <h2>Stages and actions</h2>
              </div>
              <button
                className="button button--with-icon"
                type="button"
                onClick={addStage}
              >
                <PlusIcon aria-hidden="true" />
                Add stage
              </button>
            </div>
            <div className="stage-list">
              {stages.map((stage, index) => (
                <article className="stage-card" key={`${stage.key}-${index}`}>
                  <div className="stage-number">{index + 1}</div>
                  <div className="stage-fields">
                    <div className="field-row">
                      <label>
                        Stage name
                        <input
                          value={stage.key}
                          onChange={(event) =>
                            update(index, { key: event.target.value })
                          }
                        />
                      </label>
                      <label>
                        Days after due
                        <input
                          type="number"
                          min="0"
                          value={stage.offsetDays}
                          onChange={(event) =>
                            update(index, {
                              offsetDays: Number(event.target.value)
                            })
                          }
                        />
                      </label>
                    </div>
                    <fieldset>
                      <legend>Actions</legend>
                      <div className="channel-options">
                        {channelOptions.map((option) => (
                          <label key={option.value}>
                            <input
                              type="checkbox"
                              checked={stage.channels.includes(option.value)}
                              onChange={() =>
                                toggleChannel(index, option.value)
                              }
                            />
                            {option.label}
                          </label>
                        ))}
                      </div>
                    </fieldset>
                    {!isVoice &&
                    stage.channels.some(
                      (channel) =>
                        channel === 'SMS' || channel === 'SMS_DAILY'
                    ) ? (
                      <label>
                        SMS template
                        <textarea
                          rows={3}
                          value={stage.template ?? ''}
                          onChange={(event) =>
                            update(index, { template: event.target.value })
                          }
                        />
                        <small>
                          Tokens: {'{{customer_name}}'},{' '}
                          {'{{invoice_number}}'}, {'{{amount_due}}'},{' '}
                          {'{{online_invoice_url}}'}
                        </small>
                      </label>
                    ) : null}
                  </div>
                  <button
                    className="icon-button"
                    type="button"
                    aria-label={`Remove ${stage.key}`}
                    onClick={() =>
                      setStages((current) =>
                        current.filter(
                          (_, stageIndex) => stageIndex !== index
                        )
                      )
                    }
                  >
                    <TrashIcon aria-hidden="true" />
                  </button>
                </article>
              ))}
            </div>
          </section>

          <section className="panel editor-section">
            <div className="panel__heading">
              <div>
                <span className="eyebrow">Safety rules</span>
                <h2>
                  {isVoice
                    ? 'Balances and call capacity'
                    : 'Balances, grouping and opt-outs'}
                </h2>
              </div>
            </div>
            <div className="field-grid">
              {!isVoice ? (
                <label>
                  SMS grouping
                  <select
                    name="smsAggregation"
                    defaultValue={initial.smsAggregation}
                  >
                    <option value="CONSOLIDATED_CUSTOMER">
                      One consolidated customer SMS
                    </option>
                    <option value="PER_INVOICE">One SMS per invoice</option>
                  </select>
                </label>
              ) : null}
              <label>
                Minimum balance
                <input
                  name="minimumBalance"
                  type="number"
                  min="0"
                  step="0.01"
                  defaultValue={initial.minimumBalance}
                />
              </label>
              {isVoice ? (
                <>
                  <label>
                    Maximum calls per run
                    <input
                      name="maxCallsPerRun"
                      type="number"
                      min="1"
                      max="25"
                      defaultValue={initial.maxCallsPerRun}
                    />
                  </label>
                  <label>
                    Seconds between calls
                    <input
                      name="cooldownSeconds"
                      type="number"
                      min="30"
                      max="3600"
                      defaultValue={initial.cooldownSeconds}
                    />
                  </label>
                </>
              ) : (
                <label>
                  Maximum SMS segments
                  <input
                    name="maxSmsSegments"
                    type="number"
                    min="1"
                    max="10"
                    defaultValue={initial.maxSmsSegments}
                  />
                </label>
              )}
              <label>
                Allowed currencies
                <input
                  name="allowedCurrencies"
                  defaultValue={initial.allowedCurrencies.join(', ')}
                />
              </label>
            </div>
            {!isVoice ? (
              <label className="check-row">
                <input
                  name="xeroEmailAfterSmsOptOut"
                  type="checkbox"
                  defaultChecked={initial.xeroEmailAfterSmsOptOut}
                />
                Continue Xero email reminders after an SMS opt-out
              </label>
            ) : null}
          </section>

          <footer className="editor-footer">
            <span>
              Activation creates a locked version and previews the next 30
              days.
            </span>
            <div>
              <button className="button" name="versionAction" value="draft">
                Save draft
              </button>
              <button
                className="button button--primary"
                name="versionAction"
                value="activate"
              >
                Activate new version
              </button>
            </div>
          </footer>
        </form>
      </div>
      <aside className="preview-panel">
        <span className="eyebrow">30-day preview</span>
        <h2>What will happen</h2>
        <div className="timeline-preview">
          {stages
            .filter((stage) => stage.offsetDays <= 30)
            .sort((a, b) => a.offsetDays - b.offsetDays)
            .map((stage) => (
              <div key={stage.key}>
                <span>
                  {stage.offsetDays === 0 ? 'Due' : `+${stage.offsetDays}d`}
                </span>
                <p>
                  <strong>{stage.key.replaceAll('-', ' ')}</strong>
                  <small>
                    {stage.channels
                      .map((channel) => channel.replaceAll('_', ' '))
                      .join(' + ')}
                  </small>
                </p>
              </div>
            ))}
        </div>
        <p className="preview-disclaimer">
          Counts are calculated from current eligible invoices. Activation
          never replays an obsolete stage.
        </p>
      </aside>
    </div>
  );
}
