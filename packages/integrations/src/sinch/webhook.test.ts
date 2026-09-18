import {
  createSign,
  generateKeyPairSync
} from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  parseSinchEvent,
  sinchCallbackCanonicalBytes,
  verifySinchCallback
} from './webhook.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048
});
const publicKeyPem = publicKey.export({
  type: 'spki',
  format: 'pem'
});
const requestLine = 'POST /api/webhooks/sinch HTTP/1.1';
const date = 'Fri, 18 Sep 2026 01:02:03 GMT';
const replyPayload = JSON.stringify({
  event_type: 'REPLY',
  reply_id: 'reply-1',
  message_id: 'message-1',
  source_number: '+61400000001',
  destination_number: '+61400000002',
  received_date: '2026-09-18T01:02:03Z',
  content: 'Can we pay Friday?',
  metadata: { outbound_id: 'outbound-1' }
});

const signFixture = (payload: string) => {
  const signer = createSign('RSA-SHA512');
  signer.update(
    sinchCallbackCanonicalBytes(
      requestLine,
      date,
      Buffer.from(payload)
    )
  );
  signer.end();
  return signer.sign(privateKey).toString('base64');
};

describe('verifySinchCallback', () => {
  it('verifies the RSA signature selected by key id', async () => {
    await expect(
      verifySinchCallback({
        requestLine,
        date,
        rawBody: Buffer.from(replyPayload),
        signatureBase64: signFixture(replyPayload),
        digest: 'SHA-512',
        cipher: 'RSA',
        keyId: 'key-1',
        publicKeys: new Map([['key-1', publicKeyPem]])
      })
    ).resolves.toBe(true);
  });

  it('rejects a modified body and an unknown key id', async () => {
    await expect(
      verifySinchCallback({
        requestLine,
        date,
        rawBody: Buffer.from(replyPayload.replace('Friday', 'Monday')),
        signatureBase64: signFixture(replyPayload),
        digest: 'SHA-512',
        cipher: 'RSA',
        keyId: 'key-1',
        publicKeys: new Map([['key-1', publicKeyPem]])
      })
    ).resolves.toBe(false);

    await expect(
      verifySinchCallback({
        requestLine,
        date,
        rawBody: Buffer.from(replyPayload),
        signatureBase64: signFixture(replyPayload),
        digest: 'SHA-512',
        cipher: 'RSA',
        keyId: 'unknown',
        publicKeys: new Map([['key-1', publicKeyPem]])
      })
    ).resolves.toBe(false);
  });

  it('rejects unsupported digest and cipher declarations', async () => {
    const base = {
      requestLine,
      date,
      rawBody: Buffer.from(replyPayload),
      signatureBase64: signFixture(replyPayload),
      keyId: 'key-1',
      publicKeys: new Map([['key-1', publicKeyPem]])
    };
    await expect(
      verifySinchCallback({
        ...base,
        digest: 'MD5',
        cipher: 'RSA'
      })
    ).resolves.toBe(false);
    await expect(
      verifySinchCallback({
        ...base,
        digest: 'SHA-512',
        cipher: 'ECDSA'
      })
    ).resolves.toBe(false);
  });
});

describe('parseSinchEvent', () => {
  it('maps a reply even when message_id is absent', () => {
    expect(
      parseSinchEvent(
        Buffer.from(
          JSON.stringify({
            event_type: 'REPLY',
            reply_id: 'reply-2',
            source_number: '+61400000001',
            destination_number: '+61400000002',
            received_date: '2026-09-18T01:02:03Z',
            content: 'Please call me',
            metadata: {}
          })
        )
      )
    ).toEqual({
      kind: 'reply',
      replyId: 'reply-2',
      from: '+61400000001',
      to: '+61400000002',
      receivedAt: '2026-09-18T01:02:03Z',
      content: 'Please call me',
      metadata: {}
    });
  });

  it('maps an unsolicited opt-out without message_id', () => {
    expect(
      parseSinchEvent(
        Buffer.from(
          JSON.stringify({
            event_type: 'OPT_OUT',
            notification_id: 'optout-1',
            source_number: '+61400000001',
            destination_number: '+61400000002',
            received_date: '2026-09-18T01:02:03Z',
            content: 'STOP'
          })
        )
      )
    ).toEqual({
      kind: 'opt-out',
      notificationId: 'optout-1',
      from: '+61400000001',
      to: '+61400000002',
      receivedAt: '2026-09-18T01:02:03Z',
      content: 'STOP'
    });
  });

  it.each([
    ['QUEUED', 100, 'nonterminal'],
    ['DELIVERED', 0, 'delivered'],
    ['delivered', 220, 'delivered'],
    ['REJECTED', 400, 'permanently-failed']
  ] as const)(
    'categorises delivery status %s as %s',
    (status, statusCode, category) => {
      expect(
        parseSinchEvent(
          Buffer.from(
            JSON.stringify({
              event_type: 'DELIVERY_REPORT',
              message_id: 'message-1',
              status,
              status_code: statusCode,
              timestamp: '2026-09-18T01:02:03Z',
              metadata: { outbound_id: 'outbound-1' }
            })
          )
        )
      ).toMatchObject({
        kind: 'delivery',
        messageId: 'message-1',
        status,
        statusCode,
        category
      });
    }
  );

  it('maps duplicate payload bytes deterministically', () => {
    const raw = Buffer.from(replyPayload);
    expect(parseSinchEvent(raw)).toEqual(parseSinchEvent(raw));
  });
});
