import { describe, expect, it } from 'vitest';

import { selectPreferredSmsChannel } from './channels.js';

describe('selectPreferredSmsChannel', () => {
  it('prefers an approved usable override over the original number', () => {
    const original = {
      id: 'channel-a',
      usable: true,
      approvedOverride: false,
      normalisedValue: '+61400000000'
    };
    const override = {
      id: 'channel-z',
      usable: true,
      approvedOverride: true,
      normalisedValue: '+61400000001'
    };

    expect(selectPreferredSmsChannel([original, override])).toBe(override);
  });

  it('selects the same canonical usable channel regardless of query order', () => {
    const first = {
      id: 'channel-a',
      usable: true,
      approvedOverride: false,
      normalisedValue: '+61400000000'
    };
    const second = {
      id: 'channel-b',
      usable: true,
      approvedOverride: false,
      normalisedValue: '+61400000001'
    };

    expect(selectPreferredSmsChannel([second, first])).toBe(first);
    expect(selectPreferredSmsChannel([first, second])).toBe(first);
  });
});
