import { workerRepairCooldownMs, type WorkerRepairRequestView } from '@bc5000/db/web';

import {
  WorkerRepairForm,
  WorkerRepairRefreshButton,
  type WorkerRepairFormAction
} from './worker-repair-form.js';

const statusLabels: Record<WorkerRepairRequestView['status'], string> = {
  PENDING: 'Waiting for the host',
  RUNNING: 'Repair in progress',
  SUCCEEDED: 'Repair complete',
  SKIPPED: 'Repair skipped',
  FAILED: 'Repair unsuccessful',
  EXPIRED: 'Repair expired'
};

const resultLabels: Record<NonNullable<WorkerRepairRequestView['resultCode']>, string> = {
  ALREADY_HEALTHY: 'The worker passed its readiness check. If SMS is delayed, check the sequence time and its permitted contact window.',
  STARTUP_IN_PROGRESS: 'The worker is starting. Refresh repair status after startup.',
  RESTARTED_HEALTHY: 'Worker restarted and passed the readiness check.',
  CORRECTED_RELEASE_REQUIRED: 'The worker image needs a corrected release.',
  SEND_BACKLOG_REVIEW_REQUIRED: 'Older queued reminders require a review before the worker can restart.',
  RESTART_FAILED: 'The worker could not restart.',
  HEALTH_TIMEOUT: 'The worker did not pass its readiness check in time.',
  OWNER_REVOKED: 'Owner access was revoked before the host ran the repair.',
  EXPIRED_BEFORE_START: 'The host did not start the request within its time limit.',
  EXPIRED_AFTER_CLAIM: 'The host did not complete the request within its time limit.',
  SERVICE_UNAVAILABLE: 'The host could not verify the worker service.'
};

const healthLabels: Record<NonNullable<WorkerRepairRequestView['beforeHealth']>, string> = {
  HEALTHY: 'Healthy',
  STARTING: 'Starting',
  UNHEALTHY: 'Unhealthy',
  DOWN: 'Down',
  UNVERIFIED: 'Unverified'
};

const formatTime = new Intl.DateTimeFormat('en-AU', {
  timeZone: 'Australia/Sydney',
  day: 'numeric',
  month: 'short',
  hour: 'numeric',
  minute: '2-digit',
  timeZoneName: 'short'
});

function RepairTime({ value }: { value: Date | null }) {
  return value === null ? '—' : <time dateTime={value.toISOString()}>{formatTime.format(value)}</time>;
}

export function WorkerRepairPanel({
  repair,
  action,
  now
}: {
  repair: { latest: WorkerRepairRequestView | null; runnerAvailable: boolean } | null;
  action: WorkerRepairFormAction;
  now: Date;
}) {
  const latest = repair?.latest ?? null;
  const cooldownUntil = latest === null
    ? null
    : new Date(latest.requestedAt.getTime() + workerRepairCooldownMs);
  const cooldownActive = cooldownUntil !== null && cooldownUntil > now;
  const active = latest?.status === 'PENDING' || latest?.status === 'RUNNING';
  const available = repair?.runnerAvailable === true;

  return (
    <section className="panel platform-control-card" id="worker-repair" aria-labelledby="worker-repair-heading">
      <div className="panel__heading">
        <div>
          <h2 id="worker-repair-heading">Worker repair</h2>
          <p>Check the background worker and restart it if recovery is needed.</p>
        </div>
        <WorkerRepairRefreshButton />
      </div>
      {repair === null && <p role="status">Worker repair status could not be loaded.</p>}
      {repair !== null && !available && <p role="status">The host repair service is unavailable.</p>}
      {repair !== null && latest === null && <p>No worker repairs have been requested.</p>}
      {latest !== null && (
        <>
          <p role="status">
            <strong>{statusLabels[latest.status]}</strong>
            {latest.resultCode === null ? '' : ` · ${resultLabels[latest.resultCode]}`}
          </p>
          <dl className="platform-fact-grid">
            <div>
              <dt>Worker before</dt>
              <dd>{latest.beforeHealth === null ? 'Not checked' : healthLabels[latest.beforeHealth]}</dd>
            </div>
            <div>
              <dt>Worker after</dt>
              <dd>{latest.afterHealth === null ? 'Not checked' : healthLabels[latest.afterHealth]}</dd>
            </div>
            <div><dt>Requested</dt><dd><RepairTime value={latest.requestedAt} /></dd></div>
            <div><dt>Started</dt><dd><RepairTime value={latest.claimedAt} /></dd></div>
            <div><dt>Completed</dt><dd><RepairTime value={latest.completedAt} /></dd></div>
          </dl>
        </>
      )}
      {cooldownActive && !active && (
        <p>Another repair can be requested after <RepairTime value={cooldownUntil} />.</p>
      )}
      <WorkerRepairForm action={action} disabled={!available || active || cooldownActive} />
    </section>
  );
}
