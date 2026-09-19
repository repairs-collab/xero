export type InvoiceType = 'ACCREC' | 'ACCPAY';

export type InvoiceStatus =
  | 'DRAFT'
  | 'SUBMITTED'
  | 'AUTHORISED'
  | 'PAID'
  | 'VOIDED'
  | 'DELETED';

export type Channel = 'SMS' | 'XERO_EMAIL';

export type SequenceMode = 'REVIEW' | 'AUTOMATIC';

export type PauseScope = 'customer' | 'invoice' | 'sequence';
