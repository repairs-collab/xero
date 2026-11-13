import { describe, expect, it } from 'vitest';

import { settingsCardsForRole } from './settings-cards.js';

describe('customer settings navigation', () => {
  it('offers a Xero-only connection card without exposing the SMS provider', () => {
    const cards = settingsCardsForRole('ADMIN');
    const connection = cards.find((card) => card.href === '/settings/integrations');

    expect(connection).toMatchObject({
      title: 'Xero connection',
      description: 'Connect, reconnect and sync your Xero organisation'
    });
    expect(JSON.stringify(cards)).not.toContain('Sinch');
    expect(cards.find((card) => card.href === '/settings/test-sms')?.title).toBe(
      'Test sending'
    );
    expect(
      settingsCardsForRole('OPERATOR').some(
        (card) => card.href === '/settings/integrations'
      )
    ).toBe(false);
  });
});
