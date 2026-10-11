export type VoiceGatewaySessionState =
  | 'PENDING'
  | 'PROVIDER_REQUESTED'
  | 'GATEWAY_LEG_ANSWERED'
  | 'CUSTOMER_RINGING'
  | 'CUSTOMER_ANSWERED'
  | 'IN_PROGRESS'
  | 'COMPLETED'
  | 'FAILED'
  | 'UNKNOWN'
  | 'CANCELLED';

export interface VoiceGatewayInvoiceFact {
  invoiceNumber: string;
  amountDue: string;
  dueDate: string;
}

export interface VoiceGatewayCallCommand {
  version: 1;
  purpose: 'TEST' | 'CUSTOMER';
  gatewayCallId: string;
  organisationId: string;
  voiceCallId: string;
  idempotencyKey: string;
  provider: 'VOIPCLOUD';
  providerUserNumber: string;
  destinationNumber: string;
  callerId: string;
  flowVersion: number;
  ttsVoiceId: string;
  callbackUrl: string;
  transfer: {
    sipUri?: string;
    fallbackNumber: string;
    label: string;
  };
  approvedFacts: {
    accountName: string;
    combinedAmount: string;
    currency: string;
    invoices: readonly VoiceGatewayInvoiceFact[];
  };
}

export interface VoiceGatewayCreateResult {
  gatewayCallId: string;
  state: VoiceGatewaySessionState;
  created: boolean;
}

export interface VoiceGatewayHealth {
  ready: boolean;
  version: number;
  provider: 'VOIPCLOUD';
  callsEnabled: boolean;
}

export interface VoiceGatewayCallStatus {
  gatewayCallId: string;
  organisationId: string;
  voiceCallId: string;
  providerUserNumber: string;
  state: VoiceGatewaySessionState;
  lastEventSequence: number;
  safeFailureCode: string | null;
  createdAt: string;
  updatedAt: string;
}

export class VoiceGatewayAuthenticationError extends Error {
  constructor() {
    super('Voice gateway authentication failed');
    this.name = 'VoiceGatewayAuthenticationError';
  }
}

export class VoiceGatewayConflictError extends Error {
  constructor(public readonly code: string) {
    super('Voice gateway rejected a conflicting call request');
    this.name = 'VoiceGatewayConflictError';
  }
}

export class VoiceGatewayPermanentError extends Error {
  constructor(public readonly status: number | null) {
    super('Voice gateway rejected the request');
    this.name = 'VoiceGatewayPermanentError';
  }
}

export class VoiceGatewayTransientError extends Error {
  constructor(public readonly status: number | null) {
    super('Voice gateway is temporarily unavailable');
    this.name = 'VoiceGatewayTransientError';
  }
}

export class VoiceGatewayUnknownDispatchError extends Error {
  constructor() {
    super('Voice gateway call submission outcome is unknown');
    this.name = 'VoiceGatewayUnknownDispatchError';
  }
}
