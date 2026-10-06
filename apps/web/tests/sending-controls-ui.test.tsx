import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  CUSTOMER_ROLLOUT_ACKNOWLEDGEMENT,
  CUSTOMER_ROLLOUT_OVERRIDE_ACKNOWLEDGEMENT,
  type CustomerRolloutReadiness,
  RECONCILIATION_ACKNOWLEDGEMENT
} from '../src/app/(protected)/settings/sending/sending-settings.js';
import {
  rolloutFeedback,
  rolloutModeLabel,
  RolloutGateList
} from '../src/components/rollout-gate-list.js';
import {
  ReconciliationSummary,
  ResetStatusPanel
} from '../src/components/reconciliation-summary.js';

const now = new Date('2026-09-29T02:00:00.000Z');

const readiness: CustomerRolloutReadiness = {
  organisationId: '10000000-0000-4000-8000-000000000001',
  operationalState: 'RECONCILED',
  operationalStateVersion: 4,
  metrics: {
    activeContactCount: 18,
    outstandingInvoiceCount: 23,
    outstandingTotals: { AUD: '12842.5500', NZD: '300.0000' },
    generatedApprovalCount: 7,
    enabledSequenceCount: 1,
    allEnabledSequencesReview: true
  },
  gates: {
    controlledLive: {
      passed: true,
      evidence: { sendMode: 'live', rolloutScope: 'CONTROLLED' }
    },
    providersHealthy: {
      passed: false,
      evidence: [
        {
          id: 'xero-connection-id',
          provider: 'XERO',
          authenticatedAt: now
        }
      ]
    },
    syncFresh: { passed: true, evidence: { timestamp: now } },
    importedDataPresent: {
      passed: true,
      evidence: { activeContactCount: 18, outstandingInvoiceCount: 23 }
    },
    controlledSmsEvidence: {
      passed: true,
      evidence: {
        id: 'safe-sms-evidence-id',
        status: 'DELIVERED',
        timestamp: now
      }
    },
    resetIdle: { passed: true, evidence: { activeResetId: null } },
    enabledSequencesReview: {
      passed: true,
      evidence: { enabledSequenceCount: 1 }
    },
    reconciliationCurrent: {
      passed: true,
      evidence: {
        id: 'reconciliation-id',
        syncCompletedAt: now,
        acknowledgedAt: now
      }
    }
  },
  readyForCustomerAcknowledgement: false
};

describe('final rollout controls', () => {
  it('uses exactly the three approved sending-state labels', () => {
    expect(rolloutModeLabel('dry-run', 'CONTROLLED')).toBe('Dry run');
    expect(rolloutModeLabel('live', 'CONTROLLED')).toBe('Controlled live');
    expect(rolloutModeLabel('live', 'CUSTOMER')).toBe('Customer live');
  });

  it('renders every gate with corrective guidance and safe SMS evidence', () => {
    const html = renderToStaticMarkup(
      createElement(RolloutGateList, { readiness })
    );

    expect(html).toContain('Controlled live is active');
    expect(html).toContain('Xero and Sinch checks are current');
    expect(html).toContain('Run both connection tests in Integrations');
    expect(html).toContain('Fresh Xero sync');
    expect(html).toContain('Imported receivables are present');
    expect(html).toContain('Controlled Test SMS');
    expect(html).toContain('safe-sms-evidence-id');
    expect(html).toContain('DELIVERED');
    expect(html).toContain('No operational reset is active');
    expect(html).toContain('Enabled sequences are in Review');
    expect(html).toContain('Current sync is reconciled');
    expect(html).not.toContain('+61400000001');
    expect(html).not.toContain('Private message content');
    expect(html).not.toMatch(/test xero email/i);
  });

  it('renders reconciliation counts and currency totals without customer PII', () => {
    const html = renderToStaticMarkup(
      createElement(ReconciliationSummary, {
        metrics: readiness.metrics,
        syncCompletedAt: now,
        reconciliationCurrent: true
      })
    );

    expect(html).toContain('18');
    expect(html).toContain('23');
    expect(html).toContain('7');
    expect(html).toContain('AUD');
    expect(html).toContain('12,842.55');
    expect(html).toContain('NZD');
    expect(html).toContain('300.00');
    expect(html).toContain('Reconciliation complete');
    expect(html).not.toContain('Acme Workshop');
  });

  it('shows the protected reset lifecycle without exposing a reset button', () => {
    const html = renderToStaticMarkup(
      createElement(ResetStatusPanel, {
        operationalState: 'SYNC_REQUIRED',
        resetRun: {
          id: 'reset-run-id',
          status: 'COMPLETED',
          snapshotIdentifier: 'accountpulse-production-safe-snapshot',
          snapshotCreatedAt: now,
          completedAt: now
        }
      })
    );

    expect(html).toContain('Reset complete');
    expect(html).toContain('Snapshot created');
    expect(html).toContain('Operational data deleted');
    expect(html).toContain('Fresh Xero sync required');
    expect(html).toContain('accountpulse-production-safe-snapshot');
    expect(html).not.toMatch(/<button[^>]*>[^<]*reset/i);
  });

  it('names each protected reset phase clearly', () => {
    const cases = [
      ['PREPARING', 'Reset preparation in progress'],
      ['SNAPSHOT_CREATED', 'Snapshot ready'],
      ['RESETTING', 'Operational data deletion in progress'],
      ['FAILED', 'Reset needs attention'],
      ['ABORTED', 'Reset aborted']
    ] as const;
    for (const [status, label] of cases) {
      const html = renderToStaticMarkup(
        createElement(ResetStatusPanel, {
          operationalState: 'RESET_PREPARING',
          resetRun: {
            id: `run-${status}`,
            status,
            snapshotIdentifier: null,
            snapshotCreatedAt: null,
            completedAt: null
          }
        })
      );
      expect(html).toContain(label);
      if (status === 'ABORTED') {
        expect(html).toContain('Fresh Xero sync not required');
        expect(html).toContain('Reconciliation not required');
        expect(html).not.toContain('Fresh Xero sync complete');
        expect(html).not.toContain('Reconciliation complete');
      }
    }
  });

  it('does not trust stale success codes over the current rollout state', () => {
    const controlledState = {
      sendMode: 'live' as const,
      rolloutScope: 'CONTROLLED' as const,
      operationalState: 'RECONCILED',
      reconciliationCurrent: true
    };
    expect(rolloutFeedback('customer-enabled', controlledState)).toBeNull();
    expect(
      rolloutFeedback('provider-sending-disabled', controlledState)
    ).toBeNull();
    expect(rolloutFeedback('controlled-enabled', controlledState)?.tone).toBe(
      'success'
    );

    const dryRunState = {
      ...controlledState,
      sendMode: 'dry-run' as const
    };
    expect(
      rolloutFeedback('provider-sending-disabled', dryRunState)?.title
    ).toBe('All provider sending disabled');
  });

  it('keeps reconciliation and final-customer acknowledgements distinct', () => {
    expect(RECONCILIATION_ACKNOWLEDGEMENT).toContain('current Xero');
    expect(CUSTOMER_ROLLOUT_ACKNOWLEDGEMENT).toContain(
      'approved reminders may be sent to customers'
    );
    expect(RECONCILIATION_ACKNOWLEDGEMENT).not.toBe(
      CUSTOMER_ROLLOUT_ACKNOWLEDGEMENT
    );
    expect(CUSTOMER_ROLLOUT_OVERRIDE_ACKNOWLEDGEMENT).toBe(
      'OVERRIDE SETUP CHECKS AND ENABLE CUSTOMER LIVE'
    );
    expect(CUSTOMER_ROLLOUT_OVERRIDE_ACKNOWLEDGEMENT).not.toBe(
      CUSTOMER_ROLLOUT_ACKNOWLEDGEMENT
    );
  });
});
