import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  evaluateXeroWebhook,
  parseVerifiedXeroWebhook,
  verifyXeroWebhook
} from './webhook.js';

const signatureFor = (body: Buffer, key = 'webhook-key') =>
  createHmac('sha256', key).update(body).digest('base64');

describe('verifyXeroWebhook', () => {
  it('accepts a correct Xero HMAC-SHA256 signature over the raw body', () => {
    const raw = Buffer.from('{"events":[],"entropy":"abc"}');
    expect(verifyXeroWebhook(raw, signatureFor(raw), 'webhook-key')).toBe(
      true
    );
  });

  it('rejects a modified body', () => {
    const signed = Buffer.from('{"events":[],"entropy":"abc"}');
    const modified = Buffer.from('{"events":[]}');
    expect(
      verifyXeroWebhook(modified, signatureFor(signed), 'webhook-key')
    ).toBe(false);
  });

  it('rejects malformed signatures without throwing', () => {
    expect(
      verifyXeroWebhook(Buffer.from('{"events":[]}'), 'not-base64', 'key')
    ).toBe(false);
  });
});

describe('parseVerifiedXeroWebhook', () => {
  it('accepts invoice create/update events and records ignored categories', () => {
    const raw = Buffer.from(
      JSON.stringify({
        events: [
          {
            resourceId: 'invoice-1',
            eventCategory: 'INVOICE',
            eventType: 'UPDATE',
            eventDateUtc: '2026-09-18T01:00:00Z'
          },
          {
            resourceId: 'contact-1',
            eventCategory: 'CONTACT',
            eventType: 'UPDATE',
            eventDateUtc: '2026-09-18T01:00:00Z'
          }
        ]
      })
    );

    expect(
      parseVerifiedXeroWebhook(raw, signatureFor(raw), 'webhook-key')
    ).toEqual({
      accepted: [
        {
          resourceId: 'invoice-1',
          eventType: 'UPDATE',
          eventDateUtc: '2026-09-18T01:00:00Z'
        }
      ],
      ignored: [
        {
          resourceId: 'contact-1',
          reason: 'UNSUPPORTED_CATEGORY_OR_EVENT'
        }
      ]
    });
  });
});

describe('evaluateXeroWebhook', () => {
  it('returns 200 for a valid intent-to-receive payload', () => {
    const raw = Buffer.from('{"events":[],"entropy":"abc"}');
    expect(evaluateXeroWebhook(raw, signatureFor(raw), 'webhook-key')).toEqual({
      status: 200,
      body: ''
    });
  });

  it('returns 401 for an invalid intent-to-receive signature', () => {
    expect(
      evaluateXeroWebhook(
        Buffer.from('{"events":[],"entropy":"abc"}'),
        'invalid',
        'webhook-key'
      )
    ).toEqual({ status: 401, body: '' });
  });
});
