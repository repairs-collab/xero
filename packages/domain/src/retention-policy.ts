export type AccountRetentionStatus =
  | 'SCHEDULED'
  | 'REVIEW_REQUIRED'
  | 'LEGAL_HOLD'
  | 'COMPLETED';

export type RetentionRecordCategory =
  | 'XERO_REFRESH_TOKEN'
  | 'OAUTH_TRANSIENT_TOKEN'
  | 'UNRESOLVED_RECEIVABLE'
  | 'OUTBOUND_MESSAGE_CONTENT'
  | 'INBOUND_MESSAGE_CONTENT'
  | 'PROCESSED_WEBHOOK_PAYLOAD'
  | 'CUSTOMER_RECORD'
  | 'INVOICE_RECORD'
  | 'MESSAGE_METADATA'
  | 'CALL_METADATA'
  | 'AUDIT_METADATA'
  | 'BILLING_RECORD'
  | 'DIRECT_DEBIT_MANDATE_EVIDENCE'
  | 'DATABASE_BACKUP';

export interface RetentionMatrixRow {
  category: RetentionRecordCategory;
  trigger: string;
  duration: string | null;
  action: string;
  implementation: 'ENFORCED' | 'REQUIRES_POLICY_APPROVAL' | 'HOSTING_EVIDENCE_REQUIRED';
}

/**
 * Product defaults that are already implemented or explicitly approved in the
 * AccountPulse design. A null duration is deliberate: it prevents product code
 * or public wording from inventing a legal or hosting retention promise.
 */
export const accountPulseRetentionMatrix: readonly RetentionMatrixRow[] = [
  {
    category: 'XERO_REFRESH_TOKEN',
    trigger: 'Xero disconnect, expired trial or effective subscription cancellation',
    duration: 'Immediate',
    action: 'Revoke the remote connection and remove the encrypted local refresh token.',
    implementation: 'ENFORCED'
  },
  {
    category: 'OAUTH_TRANSIENT_TOKEN',
    trigger: 'OAuth transaction consumed or expired',
    duration: 'At expiry',
    action: 'Delete the transient authorisation and encrypted pending token.',
    implementation: 'ENFORCED'
  },
  {
    category: 'UNRESOLVED_RECEIVABLE',
    trigger: 'Account retention deadline reached while an invoice remains unresolved',
    duration: 'Until reviewed',
    action: 'Hold automatic deletion and require an authorised retention review.',
    implementation: 'ENFORCED'
  },
  {
    category: 'OUTBOUND_MESSAGE_CONTENT',
    trigger: 'Related invoice resolved',
    duration: '24 months',
    action: 'Redact content while preserving delivery, hash and audit metadata.',
    implementation: 'ENFORCED'
  },
  {
    category: 'INBOUND_MESSAGE_CONTENT',
    trigger: 'All invoices for the contact resolved',
    duration: '24 months',
    action: 'Redact inbound and operator-reply bodies while preserving metadata.',
    implementation: 'ENFORCED'
  },
  {
    category: 'PROCESSED_WEBHOOK_PAYLOAD',
    trigger: 'Webhook processed successfully',
    duration: '90 days',
    action: 'Delete the raw projection; never delete an unprocessed event by age alone.',
    implementation: 'ENFORCED'
  },
  {
    category: 'CUSTOMER_RECORD',
    trigger: 'Account cancellation',
    duration: '5 years after account cancellation',
    action: 'Preserve required customer evidence until scoped manual deletion review.',
    implementation: 'ENFORCED'
  },
  {
    category: 'INVOICE_RECORD',
    trigger: 'Account cancellation',
    duration: '5 years after account cancellation',
    action: 'Preserve required invoice evidence until scoped manual deletion review.',
    implementation: 'ENFORCED'
  },
  {
    category: 'MESSAGE_METADATA',
    trigger: 'Account cancellation',
    duration: '5 years after account cancellation',
    action: 'Preserve delivery and audit metadata after shorter content redaction.',
    implementation: 'ENFORCED'
  },
  {
    category: 'CALL_METADATA',
    trigger: 'Account cancellation',
    duration: '5 years after account cancellation',
    action: 'Preserve required call outcomes and audit metadata after content minimisation.',
    implementation: 'ENFORCED'
  },
  {
    category: 'AUDIT_METADATA',
    trigger: 'Account cancellation',
    duration: '5 years after account cancellation',
    action: 'Preserve required audit evidence until scoped manual deletion review.',
    implementation: 'ENFORCED'
  },
  {
    category: 'BILLING_RECORD',
    trigger: 'Subscription or payment event',
    duration: null,
    action: 'Preserve until finance and Australian legal retention periods are approved.',
    implementation: 'REQUIRES_POLICY_APPROVAL'
  },
  {
    category: 'DIRECT_DEBIT_MANDATE_EVIDENCE',
    trigger: 'Provider-confirmed BECS mandate or service agreement',
    duration: 'Up to 7 years where BECS or Stripe rules require it',
    action: 'Retain only required mandate evidence; never broaden this period to other billing records.',
    implementation: 'ENFORCED'
  },
  {
    category: 'DATABASE_BACKUP',
    trigger: 'Backup created or source record deleted',
    duration: null,
    action: 'Publish only the verified OVH backup expiry and restore controls.',
    implementation: 'HOSTING_EVIDENCE_REQUIRED'
  }
] as const;

export const accountRetentionTransition = (input: {
  currentStatus: AccountRetentionStatus;
  deadline: Date;
  now: Date;
}): AccountRetentionStatus => {
  if (
    input.currentStatus === 'SCHEDULED' &&
    input.now.getTime() >= input.deadline.getTime()
  ) {
    return 'REVIEW_REQUIRED';
  }
  return input.currentStatus;
};

export type DataRequestReviewDecision =
  | { status: 'IN_REVIEW'; blockReason: null }
  | {
      status: 'BLOCKED';
      blockReason:
        | 'LEGAL_HOLD'
        | 'RETENTION_PERIOD_ACTIVE'
        | 'BACKUP_AGEING_UNVERIFIED';
    }
  | { status: 'MANUAL_REVIEW_REQUIRED'; blockReason: null };

export const dataRequestReviewDecision = (input: {
  requestType: 'EXPORT' | 'DELETION';
  legalHold: boolean;
  requestClosureEpisodeId: string | null;
  currentClosureEpisodeId: string | null;
  deletionEligibleAt: Date | null;
  backupExpiryVerifiedAt: Date | null;
  backupExpiryClosureEpisodeId: string | null;
  now: Date;
}): DataRequestReviewDecision => {
  if (input.requestType === 'EXPORT') {
    return { status: 'IN_REVIEW', blockReason: null };
  }
  if (input.legalHold) {
    return { status: 'BLOCKED', blockReason: 'LEGAL_HOLD' };
  }
  if (
    input.currentClosureEpisodeId === null ||
    input.requestClosureEpisodeId !== input.currentClosureEpisodeId ||
    input.deletionEligibleAt === null ||
    input.deletionEligibleAt.getTime() > input.now.getTime()
  ) {
    return { status: 'BLOCKED', blockReason: 'RETENTION_PERIOD_ACTIVE' };
  }
  if (
    input.backupExpiryVerifiedAt === null ||
    input.backupExpiryClosureEpisodeId !== input.currentClosureEpisodeId ||
    input.backupExpiryVerifiedAt.getTime() < input.deletionEligibleAt.getTime()
  ) {
    return { status: 'BLOCKED', blockReason: 'BACKUP_AGEING_UNVERIFIED' };
  }
  return { status: 'MANUAL_REVIEW_REQUIRED', blockReason: null };
};
