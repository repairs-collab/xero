import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const database = vi.hoisted(() => {
  let selectCall = 0;

  return {
    reset: () => {
      selectCall = 0;
    },
    select: () => {
      const rows =
        selectCall++ === 0
          ? [
              {
                id: 'messaging-1',
                organisationId: 'organisation-1',
                name: 'Standard bill chasing',
                kind: 'MESSAGING' as const,
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

  it('keeps the messaging and voice sections visible from the editor', async () => {
    const page = await SequenceDetailPage({
      params: Promise.resolve({ sequenceId: 'messaging-1' })
    });
    const html = renderToStaticMarkup(page);

    expect(html).toContain('aria-label="Sequence type"');
    expect(html).toContain('SMS &amp; Email Sequences');
    expect(html).toContain('Voice Reminder Sequences');
    expect(html).toContain('href="/sequences?tab=voice"');
  });
});
