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
  contentMd5?: string;
  canonical: string;
  authorization: string;
}

export function signSinchRequest(
  input: SignSinchRequestInput
): SignedSinchRequest {
  const hasBody = input.body.length > 0;
  const contentMd5 = hasBody
    ? createHash('md5')
        .update(Buffer.from(input.body, 'utf8'))
        .digest('hex')
    : undefined;
  const canonical =
    `Date: ${input.date}\n` +
    (contentMd5 === undefined ? '' : `Content-MD5: ${contentMd5}\n`) +
    `${input.method.toUpperCase()} ${input.path} HTTP/1.1`;
  const signature = createHmac('sha256', input.apiSecret)
    .update(canonical)
    .digest('base64');

  return {
    ...(contentMd5 === undefined ? {} : { contentMd5 }),
    canonical,
    authorization:
      `hmac username="${input.apiKey}", algorithm="hmac-sha256", ` +
      `headers="${hasBody ? 'Date Content-MD5 request-line' : 'Date request-line'}", ` +
      `signature="${signature}"`
  };
}
