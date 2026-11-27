import type { OrganisationEdition, XeroConnectionStatus } from '@bc5000/db/web';

// The worker starts an incremental Xero sync every 15 minutes.
const syncDelayThresholdMs = 30 * 60_000;

export const xeroSyncHealthCopy = {
  CURRENT: {
    label: 'Xero sync up to date',
    description: 'Invoice and payment data was refreshed recently.'
  },
  DELAYED: {
    label: 'Xero sync delayed',
    description: 'Invoices and payments may be out of date. Check the Xero connection in Settings.'
  },
  FIRST_SYNC_PENDING: {
    label: 'Xero first sync pending',
    description: 'Request the first sync in Settings to import invoices and payments.'
  },
  RECONNECT_REQUIRED: {
    label: 'Xero reconnection required',
    description: 'Reconnect Xero in Settings to resume invoice and payment updates.'
  },
  DISCONNECTED: {
    label: 'Xero not connected',
    description: 'Connect Xero in Settings to import invoices and payments.'
  }
} as const;

export type XeroSyncHealth = keyof typeof xeroSyncHealthCopy;

interface XeroConnectionState {
  edition: OrganisationEdition;
  oauthStatus: XeroConnectionStatus | null;
  legacyEnabled: boolean;
}

export function usesLegacyXeroConnection(input: XeroConnectionState): boolean {
  return input.edition === 'INTERNAL_LEGACY' && input.legacyEnabled &&
    (input.oauthStatus === null || input.oauthStatus === 'DISCONNECTED');
}

export function getXeroSyncHealth(
  input: XeroConnectionState & { lastSuccessfulSyncAt: Date | null },
  now: Date
): XeroSyncHealth {
  if (input.oauthStatus === 'REAUTH_REQUIRED') {
    return 'RECONNECT_REQUIRED';
  }
  if (input.oauthStatus !== 'CONNECTED' && !usesLegacyXeroConnection(input)) {
    return 'DISCONNECTED';
  }
  if (input.lastSuccessfulSyncAt === null) {
    return 'FIRST_SYNC_PENDING';
  }

  const syncAgeMs = now.getTime() - input.lastSuccessfulSyncAt.getTime();
  return syncAgeMs >= 0 && syncAgeMs <= syncDelayThresholdMs ? 'CURRENT' : 'DELAYED';
}

export function formatLastXeroSync(timestamp: Date | null, timeZone: string): string {
  if (timestamp === null) {
    return 'No successful sync recorded';
  }
  return new Intl.DateTimeFormat('en-AU', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone
  }).format(timestamp);
}
