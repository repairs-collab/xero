export interface SinchCredentials {
  apiKey: string;
  apiSecret: string;
}

export interface SinchClock {
  now(): Date;
}

export interface SinchSendSmsInput {
  content: string;
  destinationNumber: string;
  callbackUrl: string;
  metadata: Record<string, string>;
}

export type SinchSubmitResult = {
  kind: 'accepted';
  messageId: string;
  status: string;
};

export interface SinchMessageStatus {
  messageId: string;
  status: string;
  statusCode: number | null;
}

export interface SinchDeliveryEvent {
  kind: 'delivery';
  messageId: string;
  status: string;
  statusCode: number;
  category: 'nonterminal' | 'delivered' | 'permanently-failed';
  occurredAt: string;
  metadata: Record<string, string>;
}

export interface SinchReplyEvent {
  kind: 'reply';
  replyId: string;
  messageId?: string;
  from: string;
  to: string;
  receivedAt: string;
  content: string;
  metadata: Record<string, string>;
}

export interface SinchOptOutEvent {
  kind: 'opt-out';
  notificationId: string;
  messageId?: string;
  from: string;
  to: string;
  receivedAt: string;
  content: string;
}

export type SinchEvent =
  | SinchDeliveryEvent
  | SinchReplyEvent
  | SinchOptOutEvent;

export class SinchValidationFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SinchValidationFailure';
  }
}

export class SinchAuthenticationFailure extends Error {
  constructor(message = 'Sinch authentication failed') {
    super(message);
    this.name = 'SinchAuthenticationFailure';
  }
}

export class SinchPermanentSubmissionFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SinchPermanentSubmissionFailure';
  }
}

export class SinchRateLimited extends Error {
  constructor(
    public readonly retryAfterSeconds: number | null,
    message = 'Sinch rate limit exceeded'
  ) {
    super(message);
    this.name = 'SinchRateLimited';
  }
}

export class SinchTransientFailure extends Error {
  constructor(
    public readonly status: number,
    message = 'Sinch temporarily unavailable'
  ) {
    super(message);
    this.name = 'SinchTransientFailure';
  }
}

export class SinchUnknownSubmissionOutcome extends Error {
  constructor(message = 'Sinch submission outcome is unknown') {
    super(message);
    this.name = 'SinchUnknownSubmissionOutcome';
  }
}
