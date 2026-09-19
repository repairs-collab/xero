export const smsTemplateTokens = [
  'customer_name',
  'invoice_number',
  'invoice_numbers',
  'amount_due',
  'total_due',
  'currency',
  'due_date',
  'days_overdue',
  'online_invoice_url',
  'online_invoice_links',
  'organisation_name'
] as const;

export type SmsTemplateToken = (typeof smsTemplateTokens)[number];
export type SmsTemplateContext = Partial<Record<SmsTemplateToken, string>>;

export interface RenderSmsOptions {
  maxSegments: number;
}

export interface RenderedSmsPart {
  prefix: string | null;
  content: string;
}

export interface RenderedSms {
  content: string;
  encoding: 'GSM-7' | 'UCS-2';
  segmentCount: number;
  parts: RenderedSmsPart[];
}

const tokenPattern = /{{\s*([a-z_]+)\s*}}/g;
const allowedTokens = new Set<string>(smsTemplateTokens);

const gsmBasicCharacters = new Set(
  Array.from(
    '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà'
  )
);
const gsmExtendedCharacters = new Set(Array.from('^{}\\[~]|€'));

export function validateSmsTemplate(template: string): SmsTemplateToken[] {
  const tokens: SmsTemplateToken[] = [];

  for (const match of template.matchAll(tokenPattern)) {
    const token = match[1];
    if (token === undefined || !allowedTokens.has(token)) {
      throw new Error(`Unknown SMS template token: ${token ?? ''}`);
    }
    tokens.push(token as SmsTemplateToken);
  }

  return tokens;
}

const gsmUnits = (content: string): number | null => {
  let units = 0;
  for (const character of Array.from(content)) {
    if (gsmBasicCharacters.has(character)) {
      units += 1;
    } else if (gsmExtendedCharacters.has(character)) {
      units += 2;
    } else {
      return null;
    }
  }
  return units;
};

const contentUnits = (
  content: string,
  encoding: RenderedSms['encoding']
): number =>
  encoding === 'GSM-7'
    ? (gsmUnits(content) ?? 0)
    : Array.from(content).reduce(
        (total, character) => total + character.length,
        0
      );

const splitAtUnits = (
  content: string,
  maximumUnits: number,
  encoding: RenderedSms['encoding']
): [string, string] => {
  let used = 0;
  let index = 0;

  for (const character of Array.from(content)) {
    const units =
      encoding === 'GSM-7'
        ? (gsmUnits(character) ?? 0)
        : character.length;
    if (used + units > maximumUnits) break;
    used += units;
    index += character.length;
  }

  return [content.slice(0, index), content.slice(index)];
};

export function renderSms(
  template: string,
  context: SmsTemplateContext,
  options: RenderSmsOptions
): RenderedSms {
  const tokens = validateSmsTemplate(template);
  const content = template.replace(
    tokenPattern,
    (_match, rawToken: string) => {
      const token = rawToken as SmsTemplateToken;
      const value = context[token];
      if (value === undefined) {
        throw new Error(`Missing SMS template value: ${token}`);
      }
      return value;
    }
  );

  const encoding: RenderedSms['encoding'] =
    gsmUnits(content) === null ? 'UCS-2' : 'GSM-7';
  const singleLimit = encoding === 'GSM-7' ? 160 : 70;
  const multipartLimit = encoding === 'GSM-7' ? 153 : 67;
  const totalUnits = contentUnits(content, encoding);

  if (tokens.length === 0 && content.includes('{{')) {
    throw new Error('Malformed SMS template token');
  }

  if (totalUnits <= singleLimit) {
    return {
      content,
      encoding,
      segmentCount: 1,
      parts: [{ prefix: null, content }]
    };
  }

  let segmentCount = 0;
  for (let candidate = 2; candidate <= options.maxSegments; candidate += 1) {
    let capacity = 0;
    for (let part = 1; part <= candidate; part += 1) {
      capacity +=
        multipartLimit -
        contentUnits(`${part}/${candidate} `, encoding);
    }
    if (totalUnits <= capacity) {
      segmentCount = candidate;
      break;
    }
  }

  if (segmentCount === 0) {
    throw new Error(
      `Rendered SMS exceeds the ${options.maxSegments}-segment limit`
    );
  }

  const parts: RenderedSmsPart[] = [];
  let remaining = content;
  for (let part = 1; part <= segmentCount; part += 1) {
    const prefix = `${part}/${segmentCount}`;
    const capacity =
      multipartLimit - contentUnits(`${prefix} `, encoding);
    const [chunk, rest] = splitAtUnits(remaining, capacity, encoding);
    parts.push({ prefix, content: `${prefix} ${chunk}` });
    remaining = rest;
  }

  return { content, encoding, segmentCount, parts };
}
