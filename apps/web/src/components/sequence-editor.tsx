'use client';

import { useState } from 'react';

import type { ReminderStageChannel } from '@bc5000/domain';

import { activateSequenceVersion, saveSequenceDraft, setSequenceMode } from '../app/(protected)/sequences/actions.js';
import type { SequenceDraftStage } from '../app/(protected)/sequences/sequence-service.js';

const channelOptions: { value: ReminderStageChannel; label: string }[] = [
  { value: 'SMS', label: 'SMS' }, { value: 'XERO_EMAIL', label: 'Xero email' }, { value: 'TASK', label: 'Escalation task' }, { value: 'SMS_DAILY', label: 'Daily SMS thereafter' }
];

export function SequenceEditor({ organisationId, sequenceId, mode, role, initial }: { organisationId: string; sequenceId: string; mode: 'REVIEW' | 'AUTOMATIC'; role: 'ADMIN' | 'OPERATOR'; initial: { dailyBasis: 'BUSINESS_DAYS' | 'CALENDAR_DAYS'; smsAggregation: 'CONSOLIDATED_CUSTOMER' | 'PER_INVOICE'; sendTime: string; socialWindowStart: string; socialWindowEnd: string; minimumBalance: string; maxSmsSegments: number; xeroEmailAfterSmsOptOut: boolean; allowedCurrencies: string[]; stages: SequenceDraftStage[] } }) {
  const [stages, setStages] = useState(initial.stages);
  const update = (index: number, patch: Partial<SequenceDraftStage>) => setStages((current) => current.map((stage, stageIndex) => stageIndex === index ? { ...stage, ...patch } : stage));
  const toggleChannel = (index: number, channel: ReminderStageChannel) => {
    const stage = stages[index];
    if (stage === undefined) return;
    update(index, { channels: stage.channels.includes(channel) ? stage.channels.filter((item) => item !== channel) : [...stage.channels, channel] });
  };
  return (
    <div className="sequence-layout">
      <div>
        <form className="mode-panel" action={setSequenceMode}>
          <input type="hidden" name="organisationId" value={organisationId} /><input type="hidden" name="sequenceId" value={sequenceId} />
          <div><span className="eyebrow">Delivery mode</span><h2>{mode === 'REVIEW' ? 'Review and approve' : 'Automatic'}</h2><p>{mode === 'REVIEW' ? 'Every reminder waits for a person before sending.' : 'Eligible reminders send without manual approval.'}</p></div>
          <div className="segmented-control"><button name="mode" value="REVIEW" className={mode === 'REVIEW' ? 'is-active' : ''}>Review</button><button name="mode" value="AUTOMATIC" disabled={role !== 'ADMIN'} title={role !== 'ADMIN' ? 'Only Administrators can enable automatic sending' : undefined} className={mode === 'AUTOMATIC' ? 'is-active' : ''}>Automatic</button></div>
        </form>
        <form className="editor-form">
          <input type="hidden" name="organisationId" value={organisationId} /><input type="hidden" name="sequenceId" value={sequenceId} /><input type="hidden" name="stages" value={JSON.stringify(stages)} />
          <section className="panel editor-section"><div className="panel__heading"><div><span className="eyebrow">Schedule</span><h2>When reminders run</h2></div></div><div className="field-grid"><label>Day counting<select name="dailyBasis" defaultValue={initial.dailyBasis}><option value="BUSINESS_DAYS">Business days</option><option value="CALENDAR_DAYS">Calendar days</option></select></label><label>Send time<input type="time" name="sendTime" defaultValue={initial.sendTime} /></label><label>Social window starts<input type="time" name="socialWindowStart" defaultValue={initial.socialWindowStart} /></label><label>Social window ends<input type="time" name="socialWindowEnd" defaultValue={initial.socialWindowEnd} /></label></div></section>
          <section className="panel editor-section"><div className="panel__heading"><div><span className="eyebrow">Reminder journey</span><h2>Stages and channels</h2></div><button className="button" type="button" onClick={() => setStages((current) => [...current, { key: `stage-${current.length + 1}`, offsetDays: 1, channels: ['SMS'], template: 'Hi {{customer_name}}, invoice {{invoice_number}} is overdue.' }])}>+ Add stage</button></div><div className="stage-list">{stages.map((stage, index) => <article className="stage-card" key={`${stage.key}-${index}`}><div className="stage-number">{index + 1}</div><div className="stage-fields"><div className="field-row"><label>Stage name<input value={stage.key} onChange={(event) => update(index, { key: event.target.value })} /></label><label>Days after due<input type="number" min="0" value={stage.offsetDays} onChange={(event) => update(index, { offsetDays: Number(event.target.value) })} /></label></div><fieldset><legend>Actions</legend><div className="channel-options">{channelOptions.map((option) => <label key={option.value}><input type="checkbox" checked={stage.channels.includes(option.value)} onChange={() => toggleChannel(index, option.value)} />{option.label}</label>)}</div></fieldset>{stage.channels.some((channel) => channel === 'SMS' || channel === 'SMS_DAILY') && <label>SMS template<textarea rows={3} value={stage.template ?? ''} onChange={(event) => update(index, { template: event.target.value })} /><small>Tokens: {'{{customer_name}}'}, {'{{invoice_number}}'}, {'{{amount_due}}'}, {'{{online_invoice_url}}'}</small></label>}</div><button className="icon-button" type="button" aria-label={`Remove ${stage.key}`} onClick={() => setStages((current) => current.filter((_, stageIndex) => stageIndex !== index))}>×</button></article>)}</div></section>
          <section className="panel editor-section"><div className="panel__heading"><div><span className="eyebrow">Safety rules</span><h2>Balances, grouping and opt-outs</h2></div></div><div className="field-grid"><label>SMS grouping<select name="smsAggregation" defaultValue={initial.smsAggregation}><option value="CONSOLIDATED_CUSTOMER">One consolidated customer SMS</option><option value="PER_INVOICE">One SMS per invoice</option></select></label><label>Minimum balance<input name="minimumBalance" type="number" min="0" step="0.01" defaultValue={initial.minimumBalance} /></label><label>Maximum SMS segments<input name="maxSmsSegments" type="number" min="1" max="10" defaultValue={initial.maxSmsSegments} /></label><label>Allowed currencies<input name="allowedCurrencies" defaultValue={initial.allowedCurrencies.join(', ')} /></label></div><label className="check-row"><input name="xeroEmailAfterSmsOptOut" type="checkbox" defaultChecked={initial.xeroEmailAfterSmsOptOut} />Continue Xero email reminders after an SMS opt-out</label></section>
          <footer className="editor-footer"><span>Activation creates a locked version and previews the next 30 days.</span><div><button className="button" formAction={saveSequenceDraft}>Save draft</button><button className="button button--primary" formAction={activateSequenceVersion}>Activate new version</button></div></footer>
        </form>
      </div>
      <aside className="preview-panel"><span className="eyebrow">30-day preview</span><h2>What will happen</h2><div className="timeline-preview">{stages.filter((stage) => stage.offsetDays <= 30).sort((a,b) => a.offsetDays-b.offsetDays).map((stage) => <div key={stage.key}><span>{stage.offsetDays === 0 ? 'Due' : `+${stage.offsetDays}d`}</span><p><strong>{stage.key.replaceAll('-', ' ')}</strong><small>{stage.channels.map((channel) => channel.replaceAll('_', ' ')).join(' + ')}</small></p></div>)}</div><p className="preview-disclaimer">Counts are calculated from current eligible invoices. Activation never replays an obsolete stage.</p></aside>
    </div>
  );
}
