import type { CustomerRolloutReadiness } from '../app/(protected)/settings/sending/sending-settings.js';

export type RolloutFeedback = {
  tone: 'error' | 'success';
  title: string;
  detail: string;
};

type RolloutFeedbackState = {
  sendMode: 'dry-run' | 'live';
  rolloutScope: 'CONTROLLED' | 'CUSTOMER';
  operationalState: string;
  reconciliationCurrent: boolean;
};

export const rolloutModeLabel = (
  sendMode: 'dry-run' | 'live',
  rolloutScope: 'CONTROLLED' | 'CUSTOMER'
): 'Dry run' | 'Controlled live' | 'Customer live' => {
  if (sendMode === 'dry-run') return 'Dry run';
  return rolloutScope === 'CUSTOMER' ? 'Customer live' : 'Controlled live';
};

const transitionMatchesCurrentState = (
  status: string,
  state: RolloutFeedbackState
): boolean => {
  switch (status) {
    case 'controlled-enabled':
    case 'controlled-restored':
      return state.sendMode === 'live' && state.rolloutScope === 'CONTROLLED';
    case 'reconciled':
      return (
        state.operationalState === 'RECONCILED' &&
        state.reconciliationCurrent
      );
    case 'customer-enabled':
      return state.sendMode === 'live' && state.rolloutScope === 'CUSTOMER';
    case 'provider-sending-disabled':
      return state.sendMode === 'dry-run' && state.rolloutScope === 'CONTROLLED';
    default:
      return true;
  }
};

export const rolloutFeedback = (
  status: string | undefined,
  state: RolloutFeedbackState
): RolloutFeedback | null => {
  if (status !== undefined && !transitionMatchesCurrentState(status, state)) {
    return null;
  }
  switch (status) {
    case 'allowlist-updated':
      return {
        tone: 'success',
        title: 'Technical allowlist updated',
        detail: 'Controlled live and Test SMS will use the updated destinations.'
      };
    case 'controlled-enabled':
      return {
        tone: 'success',
        title: 'Controlled live is active',
        detail:
          'Only destinations on the technical recipient allowlist can reach providers.'
      };
    case 'reconciled':
      return {
        tone: 'success',
        title: 'Current Xero figures reconciled',
        detail:
          'The acknowledgement is tied to this exact successful sync. A later sync invalidates it.'
      };
    case 'customer-enabled':
      return {
        tone: 'success',
        title: 'Customer live is active',
        detail:
          'Approved reminders may now reach eligible customers. Per-message safeguards remain active.'
      };
    case 'controlled-restored':
      return {
        tone: 'success',
        title: 'Returned to controlled live',
        detail:
          'Provider calls remain live, but only technical allowlist destinations can be reached.'
      };
    case 'provider-sending-disabled':
      return {
        tone: 'success',
        title: 'All provider sending disabled',
        detail:
          'AccountPulse is in Dry run and customer rollout will require the full approval flow again.'
      };
    case 'RECONCILIATION_ACKNOWLEDGEMENT_MISMATCH':
      return {
        tone: 'error',
        title: 'Reconciliation acknowledgement did not match',
        detail: 'Type the reconciliation acknowledgement exactly as shown.'
      };
    case 'RECONCILIATION_METRICS_CHANGED':
    case 'SYNC_SUPERSEDED':
      return {
        tone: 'error',
        title: 'The Xero figures changed',
        detail:
          'Refresh this page, compare the new figures with Xero, and acknowledge the current sync.'
      };
    case 'CUSTOMER_ROLLOUT_ACKNOWLEDGEMENT_MISMATCH':
      return {
        tone: 'error',
        title: 'Customer-rollout acknowledgement did not match',
        detail: 'Type the final acknowledgement exactly as shown.'
      };
    case 'CUSTOMER_ROLLOUT_NOT_READY':
      return {
        tone: 'error',
        title: 'Customer rollout is not ready',
        detail: 'Complete each failed gate shown below, then try again.'
      };
    case 'OPERATIONAL_STATE_CONFLICT':
    case 'ROLLOUT_STATE_CONFLICT':
      return {
        tone: 'error',
        title: 'This page is out of date',
        detail: 'Refresh the page before attempting the safety change again.'
      };
    case 'REASON_REQUIRED':
    case 'REASON_TOO_LONG':
      return {
        tone: 'error',
        title: 'A valid reason is required',
        detail: 'Enter a brief operational reason and try again.'
      };
    case 'INVALID_ALLOWLIST_RECIPIENT':
      return {
        tone: 'error',
        title: 'One allowlist destination is invalid',
        detail: 'Use a valid Australian phone number or email address.'
      };
    case 'FORBIDDEN':
      return {
        tone: 'error',
        title: 'Administrator access is required',
        detail: 'Only an AccountPulse administrator can change rollout scope.'
      };
    case 'OPERATIONAL_MAINTENANCE':
      return {
        tone: 'error',
        title: 'Operational maintenance is active',
        detail: 'Wait for the protected reset workflow to finish or be aborted.'
      };
    case undefined:
      return null;
    default:
      return {
        tone: 'error',
        title: 'The safety change was not applied',
        detail: 'Refresh the page, review every gate, and try again.'
      };
  }
};

const gateCopy = {
  controlledLive: {
    title: 'Controlled live is active',
    correction:
      'Enable controlled live only after the technical recipient allowlist is ready.'
  },
  providersHealthy: {
    title: 'Xero and Sinch checks are current',
    correction: 'Run both connection tests in Integrations within 24 hours.'
  },
  syncFresh: {
    title: 'Fresh Xero sync',
    correction:
      'Fresh Xero sync required. Request a sync and return within 15 minutes.'
  },
  importedDataPresent: {
    title: 'Imported receivables are present',
    correction: 'Complete the fresh Xero sync before reconciling the figures.'
  },
  controlledSmsEvidence: {
    title: 'Controlled Test SMS',
    correction:
      'Send a Test SMS to a number on the technical allowlist and confirm it is accepted or delivered.'
  },
  resetIdle: {
    title: 'No operational reset is active',
    correction:
      'Finish or explicitly abort the protected reset workflow before customer rollout.'
  },
  enabledSequencesReview: {
    title: 'Enabled sequences are in Review',
    correction: 'Return every enabled reminder sequence to Review mode.'
  },
  reconciliationCurrent: {
    title: 'Current sync is reconciled',
    correction:
      'Compare the current figures with Xero and record the reconciliation acknowledgement.'
  }
} as const;

const formatEvidenceTime = (value: Date): string =>
  new Intl.DateTimeFormat('en-AU', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Australia/Sydney'
  }).format(value);

export function RolloutGateList({
  readiness
}: {
  readiness: CustomerRolloutReadiness;
}) {
  const entries = Object.entries(gateCopy) as Array<
    [keyof typeof gateCopy, (typeof gateCopy)[keyof typeof gateCopy]]
  >;
  const smsEvidence = readiness.gates.controlledSmsEvidence.evidence;

  return (
    <div className="rollout-gates">
      <div className="panel__heading">
        <div>
          <span className="eyebrow">Customer rollout gates</span>
          <h2>Final sending readiness</h2>
        </div>
        <span
          className={`status-chip ${readiness.readyForCustomerAcknowledgement ? 'status-chip--accepted' : 'status-chip--unknown'}`}
        >
          {readiness.readyForCustomerAcknowledgement
            ? 'Ready for approval'
            : 'Action required'}
        </span>
      </div>
      <ol className="rollout-gate-list">
        {entries.map(([key, copy]) => {
          const gate = readiness.gates[key];
          return (
            <li
              className={gate.passed ? 'rollout-gate is-passed' : 'rollout-gate'}
              key={key}
            >
              <span className="rollout-gate__marker" aria-hidden="true">
                {gate.passed ? '✓' : '!'}
              </span>
              <div>
                <strong>{copy.title}</strong>
                <p>{gate.passed ? 'Passed' : copy.correction}</p>
                {key === 'controlledSmsEvidence' && smsEvidence !== null && (
                  <small>
                    {smsEvidence.status} · {formatEvidenceTime(smsEvidence.timestamp)} · Evidence{' '}
                    <code>{smsEvidence.id}</code>
                  </small>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
