import { describe, expect, it } from 'vitest';

import {
  advanceGatewayCall,
  type GatewayCallEvent,
  type GatewayCallState
} from '../src/call-state.js';

const gatewayCallId = '11111111-1111-4111-8111-111111111111';
const initialState: GatewayCallState = {
  gatewayCallId,
  state: 'PENDING',
  lastEventSequence: 0,
  safeFailureCode: null
};

const event = (
  sequence: number,
  type: GatewayCallEvent['type'],
  safeCode?: string
): GatewayCallEvent => ({
  eventId: `event-${sequence}`,
  gatewayCallId,
  sequence,
  type,
  ...(safeCode === undefined ? {} : { safeCode }),
  occurredAt: `2026-10-09T00:00:${String(sequence).padStart(2, '0')}.000Z`
});

describe('advanceGatewayCall', () => {
  it('moves through the deterministic call lifecycle', () => {
    const provider = advanceGatewayCall(initialState, event(1, 'PROVIDER_REQUESTED'));
    const gateway = advanceGatewayCall(provider, event(2, 'GATEWAY_LEG_ANSWERED'));
    const ringing = advanceGatewayCall(gateway, event(3, 'CUSTOMER_RINGING'));
    const answered = advanceGatewayCall(ringing, event(4, 'CUSTOMER_ANSWERED'));
    const active = advanceGatewayCall(answered, event(5, 'MENU_PLAYED'));
    const completed = advanceGatewayCall(active, event(6, 'COMPLETED'));

    expect([
      provider.state,
      gateway.state,
      ringing.state,
      answered.state,
      active.state,
      completed.state
    ]).toEqual([
      'PROVIDER_REQUESTED',
      'GATEWAY_LEG_ANSWERED',
      'CUSTOMER_RINGING',
      'CUSTOMER_ANSWERED',
      'IN_PROGRESS',
      'COMPLETED'
    ]);
  });

  it('ignores replayed state changes and never regresses a later state', () => {
    const answered = advanceGatewayCall(
      initialState,
      event(4, 'CUSTOMER_ANSWERED')
    );
    expect(advanceGatewayCall(answered, event(4, 'FAILED'))).toBe(answered);

    const lateRinging = advanceGatewayCall(answered, event(5, 'CUSTOMER_RINGING'));
    expect(lateRinging).toEqual({
      ...answered,
      lastEventSequence: 5
    });
  });

  it.each(['COMPLETED', 'FAILED', 'UNKNOWN', 'CANCELLED'] as const)(
    'does not change a terminal %s state',
    (state) => {
      const terminal: GatewayCallState = {
        ...initialState,
        state,
        lastEventSequence: 8,
        safeFailureCode: state === 'FAILED' ? 'PROVIDER_REJECTED' : null
      };
      expect(
        advanceGatewayCall(terminal, event(9, 'CUSTOMER_ANSWERED'))
      ).toEqual({ ...terminal, lastEventSequence: 9 });
    }
  );

  it('retains only a bounded safe failure code', () => {
    expect(
      advanceGatewayCall(initialState, event(1, 'FAILED', 'PROVIDER_REJECTED'))
    ).toEqual({
      gatewayCallId,
      state: 'FAILED',
      lastEventSequence: 1,
      safeFailureCode: 'PROVIDER_REJECTED'
    });
    expect(JSON.stringify(event(1, 'FAILED', 'PROVIDER_REJECTED'))).not.toMatch(
      /invoice|amount|accountName|destinationNumber|recording|transcript/i
    );
  });
});
