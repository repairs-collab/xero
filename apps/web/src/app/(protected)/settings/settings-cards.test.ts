import { describe, expect, it } from 'vitest';

import { settingsCardsForRole } from './settings-cards.js';

describe('customer settings navigation', () => {
  it('offers a Xero-only connection card without exposing the SMS provider', () => {
    const cards = settingsCardsForRole('ADMIN', 'SOLO');
    const connection = cards.find((card) => card.href === '/settings/integrations');

    expect(connection).toMatchObject({
      title: 'Xero connection',
      description: 'Connect, reconnect and sync your Xero organisation'
    });
    expect(JSON.stringify(cards)).not.toContain('Sinch');
    expect(
      settingsCardsForRole('OPERATOR', 'SOLO').some(
        (card) => card.href === '/settings/integrations'
      )
    ).toBe(false);
  });

  it('keeps useful Solo settings and reserves internal diagnostics for legacy Administrators', () => {
    expect(settingsCardsForRole('ADMIN', 'SOLO').map((card) => card.href)).toEqual([
      '/settings/billing',
      '/settings/sending',
      '/settings/reminder-whitelist',
      '/settings/integrations',
      '/settings/users'
    ]);
    expect(settingsCardsForRole('ADMIN', 'INTERNAL_LEGACY').map((card) => card.href)).toEqual(
      expect.arrayContaining(['/settings/test-sms', '/settings/voice'])
    );
    expect(settingsCardsForRole('OPERATOR', 'INTERNAL_LEGACY').map((card) => card.href)).not.toContain(
      '/settings/test-sms'
    );
  });
});
