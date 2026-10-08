export interface RetellVoiceCallDynamicVariables {
  accountpulse_call_id: string;
  invoice_details_json: string;
  combined_amount: string;
  currency: string;
  callback_number: string;
  fallback_office_number: string;
  transfer_sip_uri?: string;
}

export interface RetellCreatePhoneCallInput {
  fromNumber: string;
  toNumber: string;
  idempotencyKey: string;
  agentId: string;
  agentVersion: number;
  dynamicVariables: Readonly<RetellVoiceCallDynamicVariables>;
  metadata: Readonly<RetellSafeMetadata>;
}

export interface RetellSafeMetadata {
  organisation_id: string;
  voice_call_id: string;
}

export type RetellIdentityResult = 'confirmed' | 'not_confirmed';
export type RetellTransferResult = 'bridged' | 'unanswered' | 'failed';
export type RetellFinalResult =
  | 'details_delivered'
  | 'transferred'
  | 'transfer_unanswered'
  | 'voicemail_left'
  | 'wrong_person'
  | 'no_answer'
  | 'busy'
  | 'invalid_destination'
  | 'provider_rejected';

export interface RetellStructuredOutcome {
  identityResult?: RetellIdentityResult;
  wrongPerson?: boolean;
  voicemailLeft?: boolean;
  transferRequested?: boolean;
  transferResult?: RetellTransferResult;
  finalResult?: RetellFinalResult;
}

export interface RetellSafeAnalysis {
  inVoicemail?: boolean;
  callSuccessful?: boolean;
  structuredOutcome: RetellStructuredOutcome;
}

export interface RetellCallStatus {
  callId: string;
  callStatus: string;
  startTimestamp?: number;
  endTimestamp?: number;
  disconnectionReason?: string;
  analysis?: RetellSafeAnalysis;
}

export type RetellWebhookEventType =
  | 'call_started'
  | 'call_ended'
  | 'call_analyzed';

export interface RetellWebhookEvent extends RetellCallStatus {
  eventType: RetellWebhookEventType;
  eventKey: string;
}

export class RetellPermanentError extends Error {
  constructor(
    public readonly status: number | null,
    message = 'Retell rejected the request permanently'
  ) {
    super(message);
    this.name = 'RetellPermanentError';
  }
}

export class RetellAuthenticationError extends Error {
  constructor(
    public readonly status: number,
    message = 'Retell authentication failed'
  ) {
    super(message);
    this.name = 'RetellAuthenticationError';
  }
}

export class RetellRateLimitedError extends Error {
  constructor(
    public readonly retryAfterSeconds: number | null,
    message = 'Retell rate limit exceeded'
  ) {
    super(message);
    this.name = 'RetellRateLimitedError';
  }
}

export class RetellTransientError extends Error {
  constructor(
    public readonly status: number | null,
    message = 'Retell is temporarily unavailable'
  ) {
    super(message);
    this.name = 'RetellTransientError';
  }
}

export class RetellUnknownDispatchError extends Error {
  constructor(message = 'Retell call submission outcome is unknown') {
    super(message);
    this.name = 'RetellUnknownDispatchError';
  }
}
