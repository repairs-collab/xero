import { describe, expect, it } from 'vitest';

import { currentLegalVersions } from './legal-acceptance.js';

describe('current legal document versions', () => {
  it('requires the revised Terms while keeping unchanged Privacy and Acceptable Use versions', () => {
    const previouslyAccepted = {
      termsVersion: '2026-11-11',
      privacyVersion: '2026-11-11',
      acceptableUseVersion: '2026-11-11'
    };

    expect(currentLegalVersions).toEqual({
      terms: '2026-11-12',
      privacy: '2026-11-11',
      acceptableUse: '2026-11-11'
    });
    expect(previouslyAccepted.termsVersion).not.toBe(currentLegalVersions.terms);
    expect(previouslyAccepted.privacyVersion).toBe(currentLegalVersions.privacy);
    expect(previouslyAccepted.acceptableUseVersion).toBe(
      currentLegalVersions.acceptableUse
    );
  });
});
