import type { Role } from '@bc5000/auth';
import type { OrganisationEdition } from '@bc5000/db/web';

export interface SettingsCard {
  eyebrow: string;
  title: string;
  description: string;
  href: string;
  adminOnly?: boolean;
  legacyOnly?: boolean;
}

const settingsCards: SettingsCard[] = [
  {
    eyebrow: 'Subscription',
    title: 'Plan and billing',
    description: 'AccountPulse Solo status, included SMS, and Stripe billing',
    href: '/settings/billing',
    adminOnly: true
  },
  {
    eyebrow: 'Safety',
    title: 'Sending controls',
    description: 'Dry-run, controlled allowlist, and live-mode gates',
    href: '/settings/sending'
  },
  {
    eyebrow: 'Testing',
    title: 'Test sending',
    description: 'Safely test a number and follow its status in Outbox',
    href: '/settings/test-sms',
    adminOnly: true,
    legacyOnly: true
  },
  {
    eyebrow: 'Exclusions',
    title: 'Reminder Whitelist',
    description: 'Manage clients and invoices excluded from chasing',
    href: '/settings/reminder-whitelist'
  },
  {
    eyebrow: 'Connections',
    title: 'Xero connection',
    description: 'Connect, reconnect and sync your Xero organisation',
    href: '/settings/integrations',
    adminOnly: true
  },
  {
    eyebrow: 'Voice integration',
    title: 'VoIPcloud voice',
    description: 'Configure the Australian VoIPcloud gateway and test calls',
    href: '/settings/voice',
    adminOnly: true,
    legacyOnly: true
  },
  {
    eyebrow: 'Access',
    title: 'Users and roles',
    description: 'Administrators, Operators, invitations, and access',
    href: '/settings/users'
  }
];

export const settingsCardsForRole = (
  role: Role,
  edition: OrganisationEdition
): SettingsCard[] =>
  settingsCards
    .filter(
      (card) =>
        (!card.adminOnly || role === 'ADMIN') &&
        (!card.legacyOnly || edition === 'INTERNAL_LEGACY')
    )
    .map((card) =>
      edition === 'SOLO' && card.href === '/settings/sending'
        ? {
            ...card,
            eyebrow: 'Reminders',
            title: 'Customer sending',
            description: 'Enable customer reminders and check your sending status'
          }
        : card
    );
