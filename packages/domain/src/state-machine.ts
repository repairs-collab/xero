export type StageStatus =
  | 'CALCULATED'
  | 'AWAITING_APPROVAL'
  | 'SCHEDULED'
  | 'QUEUED'
  | 'SENDING'
  | 'SENT'
  | 'UNKNOWN'
  | 'DELIVERED'
  | 'REJECTED'
  | 'SKIPPED'
  | 'CANCELLED'
  | 'FAILED_PERMANENT'
  | 'PAUSED'
  | 'SNOOZED';

export type StageEvent =
  | 'REVIEW_REQUIRED'
  | 'AUTOMATIC_ALLOWED'
  | 'APPROVED'
  | 'APPROVAL_REJECTED'
  | 'ENQUEUE'
  | 'BEGIN_SEND'
  | 'PROVIDER_ACCEPTED'
  | 'PROVIDER_REJECTED'
  | 'RESULT_UNKNOWN'
  | 'DELIVERED'
  | 'DELIVERY_REJECTED'
  | 'PERMANENT_FAILURE'
  | 'ELIGIBILITY_LOST'
  | 'SOURCE_CHANGED'
  | 'PAUSE'
  | 'SNOOZE'
  | 'RESUME'
  | 'CONFIRMED_ACCEPTED'
  | 'CONFIRMED_REJECTED'
  | 'CONFIRMED_UNSENT';

type TransitionTable = {
  [Status in StageStatus]?: Partial<Record<StageEvent, StageStatus>>;
};

const transitions: TransitionTable = {
  CALCULATED: {
    REVIEW_REQUIRED: 'AWAITING_APPROVAL',
    AUTOMATIC_ALLOWED: 'SCHEDULED',
    ELIGIBILITY_LOST: 'SKIPPED',
    SOURCE_CHANGED: 'CANCELLED',
    PAUSE: 'PAUSED',
    SNOOZE: 'SNOOZED'
  },
  AWAITING_APPROVAL: {
    APPROVED: 'QUEUED',
    APPROVAL_REJECTED: 'CANCELLED',
    ELIGIBILITY_LOST: 'SKIPPED',
    SOURCE_CHANGED: 'CANCELLED',
    PAUSE: 'PAUSED',
    SNOOZE: 'SNOOZED'
  },
  SCHEDULED: {
    ENQUEUE: 'QUEUED',
    ELIGIBILITY_LOST: 'SKIPPED',
    SOURCE_CHANGED: 'CANCELLED',
    PAUSE: 'PAUSED',
    SNOOZE: 'SNOOZED'
  },
  QUEUED: {
    BEGIN_SEND: 'SENDING',
    ELIGIBILITY_LOST: 'SKIPPED',
    SOURCE_CHANGED: 'CANCELLED',
    PAUSE: 'PAUSED',
    SNOOZE: 'SNOOZED'
  },
  SENDING: {
    PROVIDER_ACCEPTED: 'SENT',
    PROVIDER_REJECTED: 'REJECTED',
    RESULT_UNKNOWN: 'UNKNOWN',
    PERMANENT_FAILURE: 'FAILED_PERMANENT'
  },
  SENT: {
    DELIVERED: 'DELIVERED',
    DELIVERY_REJECTED: 'REJECTED'
  },
  UNKNOWN: {
    CONFIRMED_ACCEPTED: 'SENT',
    CONFIRMED_REJECTED: 'REJECTED',
    CONFIRMED_UNSENT: 'QUEUED'
  },
  PAUSED: {
    RESUME: 'CALCULATED',
    SOURCE_CHANGED: 'CANCELLED'
  },
  SNOOZED: {
    RESUME: 'CALCULATED',
    SOURCE_CHANGED: 'CANCELLED'
  }
};

const terminalStages = new Set<StageStatus>([
  'DELIVERED',
  'REJECTED',
  'SKIPPED',
  'CANCELLED',
  'FAILED_PERMANENT'
]);

export class InvalidStageTransition extends Error {
  constructor(status: StageStatus, event: StageEvent) {
    super(`Invalid reminder stage transition: ${status} + ${event}`);
    this.name = 'InvalidStageTransition';
  }
}

export function transitionStage(
  status: StageStatus,
  event: StageEvent
): StageStatus {
  const next = transitions[status]?.[event];
  if (next === undefined) throw new InvalidStageTransition(status, event);
  return next;
}

export const isTerminalStage = (status: StageStatus): boolean =>
  terminalStages.has(status);
