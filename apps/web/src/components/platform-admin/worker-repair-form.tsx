'use client';

import { useActionState } from 'react';

import type { WorkerRepairActionOutcome } from '../../app/platform-admin/system/actions.js';

export type WorkerRepairFormAction = (
  previousOutcome: WorkerRepairActionOutcome | null,
  formData: FormData
) => Promise<WorkerRepairActionOutcome>;

const feedback: Record<WorkerRepairActionOutcome, string> = {
  REQUESTED: 'Repair requested. Refresh repair status to see the outcome.',
  ALREADY_REQUESTED: 'A repair has already been requested. Refresh repair status for the latest result.',
  COOLDOWN: 'The repair cooldown is active. Refresh repair status for the next available time.',
  RUNNER_UNAVAILABLE: 'The host repair service is unavailable. Refresh repair status later.',
  CONFIRMATION_REQUIRED: 'Confirm the repair request before submitting.',
  UNAVAILABLE: 'Unable to verify this request. Refresh repair status before trying again.'
};

export function WorkerRepairRefreshButton() {
  return (
    <button className="button" type="button" onClick={() => window.location.reload()}>
      Refresh repair status
    </button>
  );
}

export function WorkerRepairForm({
  action,
  disabled
}: {
  action: WorkerRepairFormAction;
  disabled: boolean;
}) {
  const [outcome, formAction, pending] = useActionState(action, null);
  const blocked = disabled || pending || (outcome !== null && outcome !== 'CONFIRMATION_REQUIRED');

  return (
    <form action={formAction} aria-busy={pending}>
      <label className="platform-confirm">
        <input type="checkbox" name="confirmed" value="yes" required disabled={blocked} />
        I confirm I want the host to check the worker and restart it if needed.
      </label>
      <div className="button-row">
        <button className="button button--primary" type="submit" disabled={blocked}>
          {pending ? 'Requesting repair…' : 'Request worker repair'}
        </button>
      </div>
      {outcome !== null && <p className="platform-feedback" role="status">{feedback[outcome]}</p>}
    </form>
  );
}
