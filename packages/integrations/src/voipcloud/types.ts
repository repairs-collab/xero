export interface VoipcloudCallLaunchInput {
  userNumber: string;
  numberToCall: string;
  callerId?: string;
}

export interface VoipcloudCallLaunchResult {
  status: 'accepted';
  userNumber: string;
  destinationNumber: string;
  callerId?: string;
  providerCallId?: string;
}

export interface VoipcloudGetUserCallsInput {
  userNumber: string;
  from: Date;
  to: Date;
}

export interface VoipcloudUserCall {
  uniqueCallId: string;
  type: string;
  callerId?: string;
  callerName?: string;
  destinationNumber: string;
  userName: string;
  userNumber: string;
  callStartedAt: string;
  connectedAt?: string;
  callDurationSeconds?: number;
  conversationDurationSeconds?: number;
}

export class VoipcloudAuthenticationError extends Error {
  constructor(
    public readonly status: number,
    message = 'VoIPcloud authentication failed'
  ) {
    super(message);
    this.name = 'VoipcloudAuthenticationError';
  }
}

export class VoipcloudLicenceError extends Error {
  constructor(
    public readonly status: number | null,
    message = 'VoIPcloud calling is not licensed for this user'
  ) {
    super(message);
    this.name = 'VoipcloudLicenceError';
  }
}

export class VoipcloudRateLimitedError extends Error {
  constructor(
    public readonly retryAfterSeconds: number | null,
    message = 'VoIPcloud rate limit exceeded'
  ) {
    super(message);
    this.name = 'VoipcloudRateLimitedError';
  }
}

export class VoipcloudPermanentError extends Error {
  constructor(
    public readonly status: number | null,
    message = 'VoIPcloud rejected the request permanently'
  ) {
    super(message);
    this.name = 'VoipcloudPermanentError';
  }
}

export class VoipcloudTransientError extends Error {
  constructor(
    public readonly status: number | null,
    message = 'VoIPcloud is temporarily unavailable'
  ) {
    super(message);
    this.name = 'VoipcloudTransientError';
  }
}

export class VoipcloudUnknownDispatchError extends Error {
  constructor(message = 'VoIPcloud call submission outcome is unknown') {
    super(message);
    this.name = 'VoipcloudUnknownDispatchError';
  }
}
