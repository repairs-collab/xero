import { describe, expect, it, vi } from 'vitest';

import type { WebhookRepository } from '@bc5000/db/web';
import { jobNames } from '@bc5000/jobs';

import { createSinchWebhookHandler } from './webhook-handlers.js';

describe('commercial Sinch webhook routing', () => {
  it('routes a reply by its dedicated destination number before persistence', async () => {
    const recordOnceWithId = vi.fn(() =>
      Promise.resolve({ kind: 'recorded' as const, id: 'webhook-1' })
    );
    const repository = {
      recordOnce: vi.fn(),
      recordOnceWithId
    } satisfies WebhookRepository;
    const enqueueUnique = vi.fn(() => Promise.resolve('job-1'));
    const resolveOrganisationId = vi.fn(() =>
      Promise.resolve('organisation-for-number')
    );
    const handler = createSinchWebhookHandler({
      publicKeys: new Map(),
      sharedToken: 'a'.repeat(32),
      repository,
      queue: { enqueueUnique },
      resolveOrganisationId
    });
    const response = await handler(
      new Request('https://accountpulse.example/api/webhooks/sinch', {
        method: 'POST',
        headers: { 'x-accountpulse-webhook-token': 'a'.repeat(32) },
        body: JSON.stringify({
          event_type: 'REPLY',
          reply_id: 'reply-1',
          source_number: '+61400000001',
          destination_number: '+61400000009',
          received_date: '2026-11-10T00:00:00.000Z',
          content: 'Please call me.'
        })
      })
    );

    expect(response.status).toBe(202);
    expect(resolveOrganisationId).toHaveBeenCalledWith('+61400000009');
    expect(recordOnceWithId).toHaveBeenCalledWith(
      expect.objectContaining({ organisationId: 'organisation-for-number' })
    );
    expect(enqueueUnique).toHaveBeenCalledWith(
      jobNames.webhookProcess,
      expect.objectContaining({ organisationId: 'organisation-for-number' }),
      expect.stringContaining('organisation-for-number')
    );
  });

  it('acknowledges but does not persist an unknown destination', async () => {
    const recordOnceWithId = vi.fn();
    const handler = createSinchWebhookHandler({
      organisationId: 'motts-legacy-organisation',
      publicKeys: new Map(),
      sharedToken: 'b'.repeat(32),
      repository: {
        recordOnce: vi.fn(),
        recordOnceWithId
      },
      queue: { enqueueUnique: vi.fn() },
      resolveOrganisationId: () => Promise.resolve(null)
    });
    const response = await handler(
      new Request('https://accountpulse.example/api/webhooks/sinch', {
        method: 'POST',
        headers: { 'x-accountpulse-webhook-token': 'b'.repeat(32) },
        body: JSON.stringify({
          event_type: 'OPT_OUT',
          notification_id: 'opt-out-1',
          source_number: '+61400000001',
          destination_number: '+61400000009',
          received_date: '2026-11-10T00:00:00.000Z',
          content: 'STOP'
        })
      })
    );

    expect(response.status).toBe(202);
    expect(response.headers.get('x-accountpulse-ignored-destination')).toBe(
      'true'
    );
    expect(recordOnceWithId).not.toHaveBeenCalled();
  });

  it('routes a legacy opt-out by the original provider message instead of a fixed tenant fallback', async () => {
    const recordOnceWithId = vi.fn(() =>
      Promise.resolve({ kind: 'recorded' as const, id: 'webhook-opt-out' })
    );
    const resolveDeliveryOrganisationId = vi.fn(() =>
      Promise.resolve('motts-legacy-organisation')
    );
    const handler = createSinchWebhookHandler({
      organisationId: 'motts-legacy-organisation',
      publicKeys: new Map(),
      sharedToken: 'd'.repeat(32),
      repository: { recordOnce: vi.fn(), recordOnceWithId },
      queue: { enqueueUnique: vi.fn(() => Promise.resolve('job-opt-out')) },
      resolveOrganisationId: () => Promise.resolve(null),
      resolveDeliveryOrganisationId
    });
    const response = await handler(
      new Request('https://accountpulse.example/api/webhooks/sinch', {
        method: 'POST',
        headers: { 'x-accountpulse-webhook-token': 'd'.repeat(32) },
        body: JSON.stringify({
          event_type: 'OPT_OUT',
          notification_id: 'opt-out-legacy',
          message_id: 'provider-message-1',
          source_number: '+61400000001',
          destination_number: '+61400000002',
          received_date: '2026-11-10T00:00:00.000Z',
          content: 'STOP'
        })
      })
    );

    expect(response.status).toBe(202);
    expect(resolveDeliveryOrganisationId).toHaveBeenCalledWith(
      'provider-message-1'
    );
    expect(recordOnceWithId).toHaveBeenCalledWith(
      expect.objectContaining({
        organisationId: 'motts-legacy-organisation'
      })
    );
  });

  it('preserves a validated INTERNAL_LEGACY reply metadata fallback', async () => {
    const recordOnceWithId = vi.fn(() =>
      Promise.resolve({ kind: 'recorded' as const, id: 'webhook-legacy' })
    );
    const resolveLegacyOrganisationId = vi.fn(() =>
      Promise.resolve('motts-legacy-organisation')
    );
    const handler = createSinchWebhookHandler({
      publicKeys: new Map(),
      sharedToken: 'c'.repeat(32),
      repository: { recordOnce: vi.fn(), recordOnceWithId },
      queue: { enqueueUnique: vi.fn(() => Promise.resolve('job-legacy')) },
      resolveOrganisationId: () => Promise.resolve(null),
      resolveLegacyOrganisationId
    });
    const response = await handler(
      new Request('https://accountpulse.example/api/webhooks/sinch', {
        method: 'POST',
        headers: { 'x-accountpulse-webhook-token': 'c'.repeat(32) },
        body: JSON.stringify({
          event_type: 'REPLY',
          reply_id: 'reply-legacy',
          source_number: '+61400000001',
          destination_number: '+61400000002',
          received_date: '2026-11-10T00:00:00.000Z',
          content: 'Legacy reply',
          metadata: { organisationId: 'motts-legacy-organisation' }
        })
      })
    );

    expect(response.status).toBe(202);
    expect(resolveLegacyOrganisationId).toHaveBeenCalledWith(
      'motts-legacy-organisation'
    );
    expect(recordOnceWithId).toHaveBeenCalledWith(
      expect.objectContaining({
        organisationId: 'motts-legacy-organisation'
      })
    );
  });
});
