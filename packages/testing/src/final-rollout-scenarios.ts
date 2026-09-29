import type { OperationalState, RolloutScope } from '@bc5000/db';

export type FinalRolloutScenarioDefinition = {
  sendMode: 'dry-run' | 'live';
  rolloutScope: RolloutScope;
  liveSendAcknowledged: boolean;
  operationalState: OperationalState;
  operationalStateVersion: number;
  freshProviderEvidence: boolean;
  freshSync: boolean;
  controlledSmsEvidence: boolean;
  reconciliationCurrent: boolean;
  completedReset: boolean;
  operationalDataCleared: boolean;
};

export const finalRolloutScenarios = {
  dryRun: {
    sendMode: 'dry-run',
    rolloutScope: 'CONTROLLED',
    liveSendAcknowledged: false,
    operationalState: 'READY',
    operationalStateVersion: 0,
    freshProviderEvidence: false,
    freshSync: false,
    controlledSmsEvidence: false,
    reconciliationCurrent: false,
    completedReset: false,
    operationalDataCleared: false
  },
  controlledLive: {
    sendMode: 'live',
    rolloutScope: 'CONTROLLED',
    liveSendAcknowledged: true,
    operationalState: 'READY',
    operationalStateVersion: 2,
    freshProviderEvidence: true,
    freshSync: true,
    controlledSmsEvidence: false,
    reconciliationCurrent: false,
    completedReset: false,
    operationalDataCleared: false
  },
  resetSyncRequired: {
    sendMode: 'live',
    rolloutScope: 'CONTROLLED',
    liveSendAcknowledged: true,
    operationalState: 'SYNC_REQUIRED',
    operationalStateVersion: 4,
    freshProviderEvidence: true,
    freshSync: false,
    controlledSmsEvidence: false,
    reconciliationCurrent: false,
    completedReset: true,
    operationalDataCleared: true
  },
  readyForReconciliation: {
    sendMode: 'live',
    rolloutScope: 'CONTROLLED',
    liveSendAcknowledged: true,
    operationalState: 'RECONCILIATION_REQUIRED',
    operationalStateVersion: 5,
    freshProviderEvidence: true,
    freshSync: true,
    controlledSmsEvidence: true,
    reconciliationCurrent: false,
    completedReset: true,
    operationalDataCleared: false
  },
  reconciledReady: {
    sendMode: 'live',
    rolloutScope: 'CONTROLLED',
    liveSendAcknowledged: true,
    operationalState: 'RECONCILED',
    operationalStateVersion: 6,
    freshProviderEvidence: true,
    freshSync: true,
    controlledSmsEvidence: true,
    reconciliationCurrent: true,
    completedReset: true,
    operationalDataCleared: false
  },
  customerLive: {
    sendMode: 'live',
    rolloutScope: 'CUSTOMER',
    liveSendAcknowledged: true,
    operationalState: 'RECONCILED',
    operationalStateVersion: 7,
    freshProviderEvidence: true,
    freshSync: true,
    controlledSmsEvidence: true,
    reconciliationCurrent: true,
    completedReset: true,
    operationalDataCleared: false
  },
  emergencyRollback: {
    sendMode: 'dry-run',
    rolloutScope: 'CONTROLLED',
    liveSendAcknowledged: false,
    operationalState: 'RECONCILED',
    operationalStateVersion: 8,
    freshProviderEvidence: true,
    freshSync: true,
    controlledSmsEvidence: true,
    reconciliationCurrent: true,
    completedReset: true,
    operationalDataCleared: false
  }
} as const satisfies Record<string, FinalRolloutScenarioDefinition>;

export type FinalRolloutScenarioName = keyof typeof finalRolloutScenarios;

export const finalRolloutFixtureIds = {
  resetRunId: '10000000-0000-4000-8000-000000000020',
  reconciliationId: '10000000-0000-4000-8000-000000000021',
  testSmsId: '10000000-0000-4000-8000-000000000022'
} as const;
