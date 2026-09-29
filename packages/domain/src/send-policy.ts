export type ProviderSendSource =
  | 'AUTOMATED_REMINDER'
  | 'MANUAL_REMINDER'
  | 'ESCALATION_SMS'
  | 'INBOX_REPLY'
  | 'TEST_SMS'
  | 'XERO_EMAIL';

export type ProviderSendChannel = 'SMS' | 'XERO_EMAIL';

export interface ProviderSendPolicyInput {
  sendMode: 'dry-run' | 'live';
  liveSendAcknowledged: boolean;
  rolloutScope: 'CONTROLLED' | 'CUSTOMER';
  maintenanceMode: boolean;
  source: ProviderSendSource;
  channel: ProviderSendChannel;
  destination: string;
  recipientAllowlist: readonly string[];
}

export type ProviderSendPolicyDecision =
  | { kind: 'provider-call'; reason: 'ALLOWED' }
  | {
      kind: 'dry-run';
      reason:
        | 'GLOBAL_DRY_RUN'
        | 'LIVE_NOT_ACKNOWLEDGED'
        | 'CONTROLLED_RECIPIENT_NOT_ALLOWLISTED'
        | 'TEST_SMS_RECIPIENT_NOT_ALLOWLISTED';
    }
  | {
      kind: 'blocked';
      reason: 'OPERATIONAL_MAINTENANCE' | 'UNSUPPORTED_SENDING_STATE';
    };

const sources = new Set<ProviderSendSource>([
  'AUTOMATED_REMINDER',
  'MANUAL_REMINDER',
  'ESCALATION_SMS',
  'INBOX_REPLY',
  'TEST_SMS',
  'XERO_EMAIL'
]);

const supportedInput = (
  input: ProviderSendPolicyInput
): boolean => {
  if (input.sendMode !== 'dry-run' && input.sendMode !== 'live') return false;
  if (
    input.rolloutScope !== 'CONTROLLED' &&
    input.rolloutScope !== 'CUSTOMER'
  ) {
    return false;
  }
  if (input.sendMode === 'dry-run' && input.rolloutScope === 'CUSTOMER') {
    return false;
  }
  if (!sources.has(input.source)) return false;
  if (input.channel !== 'SMS' && input.channel !== 'XERO_EMAIL') return false;
  if (input.source === 'XERO_EMAIL') return input.channel === 'XERO_EMAIL';
  return input.channel === 'SMS';
};

const allowlisted = (input: ProviderSendPolicyInput): boolean =>
  input.recipientAllowlist.some((recipient) =>
    input.channel === 'XERO_EMAIL'
      ? recipient.toLowerCase() === input.destination.toLowerCase()
      : recipient === input.destination
  );

export const evaluateProviderSendPolicy = (
  input: ProviderSendPolicyInput
): ProviderSendPolicyDecision => {
  if (!supportedInput(input)) {
    return { kind: 'blocked', reason: 'UNSUPPORTED_SENDING_STATE' };
  }
  if (input.maintenanceMode) {
    return { kind: 'blocked', reason: 'OPERATIONAL_MAINTENANCE' };
  }
  if (input.sendMode === 'dry-run') {
    return { kind: 'dry-run', reason: 'GLOBAL_DRY_RUN' };
  }
  if (!input.liveSendAcknowledged) {
    return { kind: 'dry-run', reason: 'LIVE_NOT_ACKNOWLEDGED' };
  }

  const recipientAllowed = allowlisted(input);
  if (input.source === 'TEST_SMS' && !recipientAllowed) {
    return {
      kind: 'dry-run',
      reason: 'TEST_SMS_RECIPIENT_NOT_ALLOWLISTED'
    };
  }
  if (input.rolloutScope === 'CONTROLLED' && !recipientAllowed) {
    return {
      kind: 'dry-run',
      reason: 'CONTROLLED_RECIPIENT_NOT_ALLOWLISTED'
    };
  }
  return { kind: 'provider-call', reason: 'ALLOWED' };
};
