import { createHash, createHmac } from 'node:crypto';

export interface SignSinchRequestInput {
  apiKey: string;
  apiSecret: string;
  method: string;
  path: string;
  date: string;
  body: string;
}

export interface SignedSinchRequest {
  contentMd5: string;
  canonical: string;
  authorization: string;
}

export function signSinchRequest(
  input: SignSinchRequestInput
): SignedSinchRequest {
  const contentMd5 = createHash('md5')
    .update(Buffer.from(input.body, 'utf8'))
    .digest('hex');
  const canonical =
    `Date: ${input.date}\n` +
    `Content-MD5: ${contentMd5}\n` +
    `${input.method.toUpperCase()} ${input.path} HTTP/1.1`;
  const signature = createHmac('sha1', input.apiSecret)
    .update(canonical)
    .digest('base64');

  return {
    contentMd5,
    canonical,
    authorization:
      `hmac username="${input.apiKey}", algorithm="hmac-sha1", ` +
      'headers="Date Content-MD5 request-line", ' +
      `signature="${signature}"`
  };
}
