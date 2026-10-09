import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { SequenceTabs } from '../src/components/sequence-tabs.js';

const noAction = (formData: FormData): Promise<void> => {
  void formData;
  return Promise.resolve();
};

const rows = [
  {
    id: 'messaging-1',
    name: 'Standard bill chasing',
    kind: 'MESSAGING' as const,
    mode: 'REVIEW' as const,
    enabled: true,
    versionNumber: 2,
    dailyBasis: 'BUSINESS_DAYS' as const
  },
  {
    id: 'voice-1',
    name: 'Voice overdue reminders',
    kind: 'VOICE' as const,
    mode: 'AUTOMATIC' as const,
    enabled: false,
    versionNumber: 1,
    dailyBasis: 'BUSINESS_DAYS' as const
  }
];

describe('SequenceTabs', () => {
  it('defaults to messaging and does not render voice rows', () => {
    const html = renderToStaticMarkup(
      <SequenceTabs
        activeTab="messaging"
        organisationId="organisation-1"
        role="ADMIN"
        rows={rows}
        createMessagingAction={noAction}
        createVoiceAction={noAction}
      />
    );

    expect(html).toContain('SMS &amp; Email Sequences');
    expect(html).toContain('Standard bill chasing');
    expect(html).toContain('/sequences/messaging-1?tab=messaging');
    expect(html).not.toContain('Voice overdue reminders');
    expect(html).not.toContain('/sequences/voice-1');
  });

  it('renders only voice rows and preserves the voice tab in links', () => {
    const html = renderToStaticMarkup(
      <SequenceTabs
        activeTab="voice"
        organisationId="organisation-1"
        role="ADMIN"
        rows={rows}
        createMessagingAction={noAction}
        createVoiceAction={noAction}
      />
    );

    expect(html).toContain('Voice Reminder Sequences');
    expect(html).toContain('Voice overdue reminders');
    expect(html).toContain('/sequences/voice-1?tab=voice');
    expect(html).toContain('Disabled');
    expect(html).not.toContain('Standard bill chasing');
    expect(html).not.toContain('/sequences/messaging-1');
  });
});
