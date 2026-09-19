import { describe, expect, it } from 'vitest';

import {
  InvalidStageTransition,
  isTerminalStage,
  transitionStage
} from './state-machine.js';

describe('reminder stage state machine', () => {
  it.each([
    ['CALCULATED', 'REVIEW_REQUIRED', 'AWAITING_APPROVAL'],
    ['CALCULATED', 'AUTOMATIC_ALLOWED', 'SCHEDULED'],
    ['AWAITING_APPROVAL', 'APPROVED', 'QUEUED'],
    ['SCHEDULED', 'ENQUEUE', 'QUEUED'],
    ['QUEUED', 'BEGIN_SEND', 'SENDING'],
    ['SENDING', 'PROVIDER_ACCEPTED', 'SENT'],
    ['SENDING', 'RESULT_UNKNOWN', 'UNKNOWN'],
    ['SENT', 'DELIVERED', 'DELIVERED'],
    ['AWAITING_APPROVAL', 'SOURCE_CHANGED', 'CANCELLED']
  ] as const)('%s + %s -> %s', (from, event, expected) => {
    expect(transitionStage(from, event)).toBe(expected);
  });

  it('rejects every transition that is not explicitly listed', () => {
    expect(() => transitionStage('DELIVERED', 'BEGIN_SEND')).toThrow(
      InvalidStageTransition
    );
    expect(() => transitionStage('UNKNOWN', 'BEGIN_SEND')).toThrow(
      InvalidStageTransition
    );
  });

  it.each([
    'DELIVERED',
    'REJECTED',
    'SKIPPED',
    'CANCELLED',
    'FAILED_PERMANENT'
  ] as const)('marks %s as terminal', (status) => {
    expect(isTerminalStage(status)).toBe(true);
  });

  it.each(['PAUSED', 'SNOOZED', 'UNKNOWN'] as const)(
    'does not treat %s as terminal',
    (status) => {
      expect(isTerminalStage(status)).toBe(false);
    }
  );
});
