import type { Role } from '@bc5000/auth';

export interface SettingsCard {
  eyebrow: string;
  title: string;
  description: string;
  href: string;
  adminOnly?: boolean;
}

const settingsCards: SettingsCard[] = [
  {
    eyebrow: 'Safety',
    title: 'Sending controls',
    description: 'Dry-run, controlled allowlist, and live-mode gates',
    href: '/settings/sending'
  },
  {
    eyebrow: 'Testing',
    title: 'Test SMS',
    description: 'Safely test a number and follow its status in Outbox',
    href: '/settings/test-sms',
    adminOnly: true
  },
  {
    eyebrow: 'Exclusions',
    title: 'Reminder Whitelist',
    description: 'Manage clients and invoices excluded from chasing',
    href: '/settings/reminder-whitelist'
  },
  {
    eyebrow: 'Connections',
    title: 'Integrations',
    description: 'Xero, Sinch, webhooks, and secret references',
    href: '/settings/integrations'
  },
  {
    eyebrow: 'Voice',
    title: 'Voice reminders',
    description: 'Configure and test manual, privacy-safe customer calls',
    href: '/settings/voice',
    adminOnly: true
  },
  {
    eyebrow: 'Access',
    title: 'Users and roles',
    description: 'Administrators, Operators, invitations, and access',
    href: '/settings/users'
  }
];

export const settingsCardsForRole = (role: Role): SettingsCard[] =>
  settingsCards.filter((card) => !card.adminOnly || role === 'ADMIN');
