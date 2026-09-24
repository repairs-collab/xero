import { createHash, createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { signSinchRequest } from './hmac.js';

describe('signSinchRequest', () => {
  it('signs Date, Content-MD5, and request-line in documented order', () => {
    const body = '{"messages":[]}';
    const result = signSinchRequest({
      apiKey: 'key',
      apiSecret: 'secret',
      method: 'POST',
      path: '/v1/messages',
      date: 'Sat, 30 Jul 2016 05:13:23 GMT',
      body
    });
    const contentMd5 = createHash('md5').update(body).digest('hex');
    const canonical =
      `Date: Sat, 30 Jul 2016 05:13:23 GMT\n` +
      `Content-MD5: ${contentMd5}\n` +
      'POST /v1/messages HTTP/1.1';
    const signature = createHmac('sha256', 'secret')
      .update(canonical)
      .digest('base64');

    expect(result.contentMd5).toBe(contentMd5);
    expect(result.canonical).toBe(canonical);
    expect(result.authorization).toBe(
      `hmac username="key", algorithm="hmac-sha256", headers="Date Content-MD5 request-line", signature="${signature}"`
    );
  });

  it('omits Content-MD5 when signing a request without a body', () => {
    const canonical =
      'Date: Sat, 30 Jul 2016 05:18:52 GMT\n' +
      'GET /v1/webhooks/messages?page=0&page_size=1 HTTP/1.1';
    const signature = createHmac('sha256', 'secret')
      .update(canonical)
      .digest('base64');

    expect(
      signSinchRequest({
        apiKey: 'key',
        apiSecret: 'secret',
        method: 'GET',
        path: '/v1/webhooks/messages?page=0&page_size=1',
        date: 'Sat, 30 Jul 2016 05:18:52 GMT',
        body: ''
      })
    ).toEqual({
      contentMd5: undefined,
      canonical,
      authorization:
        `hmac username="key", algorithm="hmac-sha256", headers="Date request-line", ` +
        `signature="${signature}"`
    });
  });

  it('hashes Unicode content as UTF-8 bytes', () => {
    const body = '{"content":"Invoice reminder 👋"}';
    expect(
      signSinchRequest({
        apiKey: 'key',
        apiSecret: 'secret',
        method: 'POST',
        path: '/v1/messages',
        date: 'Fri, 18 Sep 2026 01:02:03 GMT',
        body
      }).contentMd5
    ).toBe(createHash('md5').update(Buffer.from(body, 'utf8')).digest('hex'));
  });
});
