import type { VoiceGatewaySessionState } from '@bc5000/db';

export type GatewayCallEventType =
  | 'PROVIDER_REQUESTED'
  | 'GATEWAY_LEG_ANSWERED'
  | 'CUSTOMER_RINGING'
  | 'CUSTOMER_ANSWERED'
  | 'VOICEMAIL_DETECTED'
  | 'MENU_PLAYED'
  | 'IDENTITY_CONFIRMED'
  | 'DETAILS_DELIVERED'
  | 'TRANSFER_REQUESTED'
  | 'TRANSFERRED'
  | 'TRANSFER_UNANSWERED'
  | 'WRONG_NUMBER'
  | 'COMPLETED'
  | 'FAILED'
  | 'UNKNOWN'
  | 'CANCELLED';

export interface GatewayCallEvent {
  eventId: string;
  gatewayCallId: string;
  sequence: number;
  type: GatewayCallEventType;
  safeCode?: string;
  occurredAt: string;
}

export interface GatewayCallState {
  gatewayCallId: string;
  state: VoiceGatewaySessionState;
  lastEventSequence: number;
  safeFailureCode: string | null;
}

const terminalStates = new Set<VoiceGatewaySessionState>([
  'COMPLETED',
  'FAILED',
  'UNKNOWN',
  'CANCELLED'
]);

const stateRank: Record<VoiceGatewaySessionState, number> = {
  PENDING: 0,
  PROVIDER_REQUESTED: 1,
  GATEWAY_LEG_ANSWERED: 2,
  CUSTOMER_RINGING: 3,
  CUSTOMER_ANSWERED: 4,
  IN_PROGRESS: 5,
  COMPLETED: 6,
  FAILED: 6,
  UNKNOWN: 6,
  CANCELLED: 6
};

const stateForEvent = (
  type: GatewayCallEventType
): VoiceGatewaySessionState => {
  switch (type) {
    case 'PROVIDER_REQUESTED':
      return 'PROVIDER_REQUESTED';
    case 'GATEWAY_LEG_ANSWERED':
      return 'GATEWAY_LEG_ANSWERED';
    case 'CUSTOMER_RINGING':
      return 'CUSTOMER_RINGING';
    case 'CUSTOMER_ANSWERED':
      return 'CUSTOMER_ANSWERED';
    case 'VOICEMAIL_DETECTED':
    case 'MENU_PLAYED':
    case 'IDENTITY_CONFIRMED':
    case 'DETAILS_DELIVERED':
    case 'TRANSFER_REQUESTED':
      return 'IN_PROGRESS';
    case 'TRANSFERRED':
    case 'TRANSFER_UNANSWERED':
    case 'WRONG_NUMBER':
    case 'COMPLETED':
      return 'COMPLETED';
    case 'FAILED':
      return 'FAILED';
    case 'UNKNOWN':
      return 'UNKNOWN';
    case 'CANCELLED':
      return 'CANCELLED';
  }
};

export const advanceGatewayCall = (
  current: GatewayCallState,
  event: GatewayCallEvent
): GatewayCallState => {
  if (
    event.gatewayCallId !== current.gatewayCallId ||
    !Number.isSafeInteger(event.sequence) ||
    event.sequence < 1 ||
    !Number.isFinite(new Date(event.occurredAt).getTime()) ||
    (event.safeCode !== undefined &&
      !/^[A-Z][A-Z0-9_]{0,63}$/.test(event.safeCode))
  ) {
    throw new Error('GATEWAY_EVENT_INVALID');
  }
  if (event.sequence <= current.lastEventSequence) return current;

  if (terminalStates.has(current.state)) {
    return { ...current, lastEventSequence: event.sequence };
  }

  const candidate = stateForEvent(event.type);
  if (stateRank[candidate] < stateRank[current.state]) {
    return { ...current, lastEventSequence: event.sequence };
  }
  return {
    ...current,
    state: candidate,
    lastEventSequence: event.sequence,
    safeFailureCode:
      candidate === 'FAILED' || candidate === 'UNKNOWN'
        ? (event.safeCode ?? null)
        : null
  };
};
