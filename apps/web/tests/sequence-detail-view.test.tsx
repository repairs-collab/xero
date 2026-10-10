import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const database = vi.hoisted(() => {
  let selectCall = 0;
  let sequenceKind: 'MESSAGING' | 'VOICE' = 'MESSAGING';

  return {
    reset: () => {
      selectCall = 0;
    },
    setSequenceKind: (kind: 'MESSAGING' | 'VOICE') => {
      sequenceKind = kind;
    },
    select: () => {
      const rows =
        selectCall++ === 0
          ? [
              {
                id: sequenceKind === 'VOICE' ? 'voice-1' : 'messaging-1',
                organisationId: 'organisation-1',
                name:
                  sequenceKind === 'VOICE'
                    ? 'Voice overdue reminders'
                    : 'Standard bill chasing',
                kind: sequenceKind,
                mode: 'AUTOMATIC' as const,
                enabled: true
              }
            ]
          : [];
      const query = {
        from: () => query,
        where: () => query,
        orderBy: () => query,
        limit: () => Promise.resolve(rows)
      };
      return query;
    }
  };
});

vi.mock('next/headers', () => ({
  headers: () => Promise.resolve(new Headers())
}));

vi.mock('../src/server/runtime.js', () => ({
  getDatabaseClient: () => ({ db: { select: database.select } }),
  requireWebSession: () =>
    Promise.resolve({
      memberships: [
        {
          active: true,
          organisationId: 'organisation-1',
          role: 'ADMIN'
        }
      ]
    })
}));

import SequenceDetailPage from '../src/app/(protected)/sequences/[sequenceId]/page.js';

describe('SequenceDetailPage', () => {
  beforeEach(() => {
    database.reset();
  });

  it.each([
    {
      kind: 'MESSAGING' as const,
      sequenceId: 'messaging-1',
      activeHref: '/sequences/messaging-1?tab=messaging',
      oppositeHref: '/sequences?tab=voice'
    },
    {
      kind: 'VOICE' as const,
      sequenceId: 'voice-1',
      activeHref: '/sequences/voice-1?tab=voice',
      oppositeHref: '/sequences?tab=messaging'
    }
  ])(
    'keeps both sequence sections visible from a $kind editor',
    async ({ kind, sequenceId, activeHref, oppositeHref }) => {
      database.setSequenceKind(kind);
      const page = await SequenceDetailPage({
        params: Promise.resolve({ sequenceId })
      });
      const html = renderToStaticMarkup(page);

      expect(html).toContain('aria-label="Sequence type"');
      expect(html).toContain('SMS &amp; Email Sequences');
      expect(html).toContain('Voice Reminder Sequences');
      expect(html).toContain(
        `class="is-active" aria-current="page" href="${activeHref}"`
      );
      expect(html).toContain(`class="" href="${oppositeHref}"`);
    }
  );
});
