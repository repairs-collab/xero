export class XeroAuthenticationFailure extends Error {
  constructor(message = 'Xero authentication failed') {
    super(message);
    this.name = 'XeroAuthenticationFailure';
  }
}

export class XeroRateLimited extends Error {
  public readonly status = 429;

  constructor(
    public readonly retryAfterSeconds: number | null,
    public readonly dailyRemaining: number | null = null,
    public readonly problem: string | null = null,
    message = 'Xero rate limit exceeded'
  ) {
    super(message);
    this.name = 'XeroRateLimited';
  }
}

export class XeroEmailPermanentFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'XeroEmailPermanentFailure';
  }
}

export class XeroTransientFailure extends Error {
  constructor(
    public readonly status: number,
    message = 'Xero temporarily unavailable'
  ) {
    super(message);
    this.name = 'XeroTransientFailure';
  }
}

export class XeroRequestFailure extends Error {
  constructor(
    public readonly status: number,
    message = 'Xero request failed'
  ) {
    super(message);
    this.name = 'XeroRequestFailure';
  }
}

export interface XeroRateLimit {
  limit: number | null;
  remaining: number | null;
  dailyRemaining: number | null;
  problem: string | null;
  retryAfterSeconds: number | null;
}

export interface XeroResult<T> {
  data: T;
  rateLimit: XeroRateLimit;
}

export interface XeroOrganisation {
  id: string;
  name: string;
  baseCurrency: string;
  timeZone: string | null;
}

export interface XeroContact {
  id: string;
  name: string;
  active: boolean;
  email: string | null;
  phones: string[];
  phoneCandidates: Array<{
    type: string;
    number: string;
  }>;
}

export interface XeroInvoice {
  id: string;
  invoiceNumber: string;
  contactId: string;
  contactName: string;
  type: 'ACCREC' | 'ACCPAY';
  status:
    | 'DRAFT'
    | 'SUBMITTED'
    | 'AUTHORISED'
    | 'PAID'
    | 'VOIDED'
    | 'DELETED';
  issueDate: string;
  dueDate: string;
  amountDue: string;
  currency: string;
  updatedAt: string | null;
}
