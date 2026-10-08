import type { ApprovedVoiceFacts } from '../contracts.js';

export type SpeechSegmentKind =
  | 'ACCOUNT_OPENING'
  | 'PROTECTED_DETAIL'
  | 'PROTECTED_SUMMARY'
  | 'VOICEMAIL';

export interface SpeechSegment {
  kind: SpeechSegmentKind;
  protected: boolean;
  text: string;
}

const maximumInvoices = 20;
const maximumEstimatedDurationMs = 180_000;
const accountNamePattern = /^[\p{L}\p{N} .,'&()/-]+$/u;
const invoiceNumberPattern = /^[A-Za-z0-9._/# -]{1,100}$/;
const amountPattern = /^(?:0|[1-9]\d{0,11})\.\d{2}$/;

const digitWords = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine'
] as const;

const smallNumberWords = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen'
] as const;

const tensWords = [
  '',
  '',
  'twenty',
  'thirty',
  'forty',
  'fifty',
  'sixty',
  'seventy',
  'eighty',
  'ninety'
] as const;

const numberBelowThousand = (value: number): string => {
  if (value < 20) return smallNumberWords[value] ?? '';
  if (value < 100) {
    const tens = tensWords[Math.floor(value / 10)] ?? '';
    const remainder = value % 10;
    return remainder === 0 ? tens : `${tens} ${smallNumberWords[remainder]}`;
  }
  const hundreds = Math.floor(value / 100);
  const remainder = value % 100;
  const prefix = `${smallNumberWords[hundreds]} hundred`;
  return remainder === 0
    ? prefix
    : `${prefix} and ${numberBelowThousand(remainder)}`;
};

const integerWords = (value: bigint): string => {
  if (value === 0n) return 'zero';
  const scales: ReadonlyArray<readonly [bigint, string]> = [
    [1_000_000_000n, 'billion'],
    [1_000_000n, 'million'],
    [1_000n, 'thousand']
  ];
  let remaining = value;
  const parts: string[] = [];
  for (const [scale, label] of scales) {
    if (remaining < scale) continue;
    const count = remaining / scale;
    remaining %= scale;
    parts.push(`${numberBelowThousand(Number(count))} ${label}`);
  }
  if (remaining > 0n) {
    const words = numberBelowThousand(Number(remaining));
    if (parts.length > 0 && remaining < 100n) parts.push(`and ${words}`);
    else parts.push(words);
  }
  return parts.join(' ');
};

const parseCents = (amount: string): bigint => {
  if (!amountPattern.test(amount)) throw new Error('VOICE_AMOUNT_INVALID');
  const [dollars, cents] = amount.split('.');
  if (dollars === undefined || cents === undefined) {
    throw new Error('VOICE_AMOUNT_INVALID');
  }
  return BigInt(dollars) * 100n + BigInt(cents);
};

const currencyLabels = (currency: string) => {
  if (currency === 'AUD') {
    return { singular: 'Australian dollar', plural: 'Australian dollars' };
  }
  if (currency === 'NZD') {
    return { singular: 'New Zealand dollar', plural: 'New Zealand dollars' };
  }
  throw new Error('VOICE_CURRENCY_UNSUPPORTED');
};

const moneyWords = (amount: string, currency: string): string => {
  const totalCents = parseCents(amount);
  const dollars = totalCents / 100n;
  const cents = Number(totalCents % 100n);
  const labels = currencyLabels(currency);
  const parts: string[] = [];
  if (dollars > 0n || cents === 0) {
    parts.push(
      `${integerWords(dollars)} ${dollars === 1n ? labels.singular : labels.plural}`
    );
  }
  if (cents > 0) {
    parts.push(`${integerWords(BigInt(cents))} ${cents === 1 ? 'cent' : 'cents'}`);
  }
  return parts.join(' and ');
};

const invoiceIdentifierWords = (invoiceNumber: string): string => {
  if (!invoiceNumberPattern.test(invoiceNumber)) {
    throw new Error('VOICE_TEXT_UNSUPPORTED');
  }
  const punctuation: Record<string, string> = {
    '-': 'dash',
    '/': 'slash',
    '_': 'underscore',
    '.': 'dot',
    '#': 'number',
    ' ': 'space'
  };
  return [...invoiceNumber]
    .map((character) => {
      if (/^[A-Za-z]$/.test(character)) return character.toUpperCase();
      if (/^\d$/.test(character)) return digitWords[Number(character)];
      return punctuation[character];
    })
    .filter((value): value is string => value !== undefined)
    .join(' ');
};

const assertSpeechLength = (segments: readonly SpeechSegment[]): void => {
  const words = segments.reduce(
    (count, segment) =>
      count + segment.text.trim().split(/\s+/).filter(Boolean).length,
    0
  );
  const estimatedDurationMs = words * 360;
  if (estimatedDurationMs > maximumEstimatedDurationMs) {
    throw new Error('VOICE_SPEECH_TOO_LONG');
  }
};

const normaliseAccountName = (accountName: string): string => {
  if (
    accountName.length === 0 ||
    accountName.length > 200 ||
    !accountNamePattern.test(accountName)
  ) {
    throw new Error('VOICE_TEXT_UNSUPPORTED');
  }
  return accountName.replace(/\s*&\s*/g, ' and ').replace(/\s+/g, ' ').trim();
};

export const formatAccountOpening = (
  accountName: string
): readonly SpeechSegment[] => {
  const approvedName = normaliseAccountName(accountName);
  const segments: SpeechSegment[] = [
    {
      kind: 'ACCOUNT_OPENING',
      protected: false,
      text: `Hello. This is an automated call from Mott Appliance Repairs intended for the account of ${approvedName}. If you are the account holder or authorised to manage this account, press 1 to hear the invoice details. To speak with a representative, press 2. If this is the wrong number, press 9.`
    }
  ];
  assertSpeechLength(segments);
  return segments;
};

export const formatProtectedDetails = (
  facts: ApprovedVoiceFacts
): readonly SpeechSegment[] => {
  if (facts.invoices.length === 0) throw new Error('VOICE_INVOICES_REQUIRED');
  if (facts.invoices.length > maximumInvoices) {
    throw new Error('VOICE_INVOICE_LIMIT_EXCEEDED');
  }
  currencyLabels(facts.currency);
  const calculatedTotal = facts.invoices.reduce(
    (total, invoice) => total + parseCents(invoice.amountDue),
    0n
  );
  if (calculatedTotal !== parseCents(facts.combinedAmount)) {
    throw new Error('VOICE_TOTAL_MISMATCH');
  }
  const segments: SpeechSegment[] = facts.invoices.map((invoice) => ({
    kind: 'PROTECTED_DETAIL',
    protected: true,
    text: `Invoice ${invoiceIdentifierWords(invoice.invoiceNumber)}. Amount ${moneyWords(invoice.amountDue, facts.currency)}.`
  }));
  segments.push({
    kind: 'PROTECTED_SUMMARY',
    protected: true,
    text: `The combined balance for these invoices is ${moneyWords(facts.combinedAmount, facts.currency)}.`
  });
  assertSpeechLength(segments);
  return segments;
};

export const formatVoicemail = (
  displayOfficeNumber: string
): readonly SpeechSegment[] => {
  if (!/^\d{2} \d{4} \d{4}$/.test(displayOfficeNumber)) {
    throw new Error('VOICE_OFFICE_NUMBER_INVALID');
  }
  return [
    {
      kind: 'VOICEMAIL',
      protected: false,
      text: `This is Mott Appliance Repairs calling. Please call our office on ${displayOfficeNumber} during business hours.`
    }
  ];
};
