export interface LifecycleEmailContentInput {
  template: string;
  templateVersion: number;
  renderData: unknown;
}

export interface RenderedLifecycleEmail {
  subject: string;
  text: string;
  html: string;
}

function invalid(): never {
  throw new Error('LIFECYCLE_EMAIL_INVALID_RENDER_DATA');
}

function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) invalid();
  return value;
}

function date(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d))?$/.test(value)) invalid();
  const day = value.slice(0, 10);
  const calendarDate = new Date(day);
  const instant = new Date(value);
  if (!Number.isFinite(instant.getTime()) || !Number.isFinite(calendarDate.getTime()) || calendarDate.toISOString().slice(0, 10) !== day) invalid();
  const formatted = instant.toLocaleDateString('en-AU', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' });
  return value === day ? formatted : `${formatted} at ${instant.toISOString().slice(11, 16)} UTC`;
}

const formatField = {
  organisationName(value: unknown) {
    if (typeof value !== 'string' || !value.trim() || /[\p{Cc}\u2028\u2029]/u.test(value)) invalid();
    return value.trim();
  },
  billingCadence(value: unknown) {
    if (typeof value !== 'string' || !/^(MONTHLY|ANNUAL)$/i.test(value)) invalid();
    return value.toLowerCase();
  },
  committedParts: (value: unknown) => integer(value).toLocaleString('en-AU'),
  includedParts: (value: unknown) => integer(value, 1).toLocaleString('en-AU'),
  warningPercent: (value: unknown) => String(integer(value, 1, 100)),
  amountMinor(value: unknown) {
    const digits = String(integer(value)).padStart(3, '0');
    return `${digits.slice(0, -2)}.${digits.slice(-2)}`;
  },
  currency(value: unknown) {
    if (typeof value !== 'string' || value.toUpperCase() !== 'AUD') invalid();
    return 'AUD';
  },
  billingPeriodEnd: date,
  recoveryEndsAt: date,
  effectiveAt: date,
  cancelledAt: date,
  dataRetainedUntil: date,
  completedAt: date,
  targetResponseAt: date,
  requestId(value: unknown) {
    if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(value)) invalid();
    return value;
  },
  requestType(value: unknown) {
    if (value !== 'EXPORT' && value !== 'DELETION') invalid();
    return value.toLowerCase();
  }
};

type ReadField = (name: keyof typeof formatField) => string;

const templates = {
  WORKSPACE_WELCOME: {
    subject: 'Welcome to AccountPulse',
    body: (field) => `Your AccountPulse workspace for ${field('organisationName')} is ready. Sign in to begin setting up your workspace.`
  },
  ONBOARDING_COMPLETED: {
    subject: 'AccountPulse onboarding complete',
    body: (field) => `Onboarding is complete for ${field('organisationName')}.`
  },
  PAYMENT_CONFIRMED: {
    subject: 'Initial AccountPulse payment confirmed',
    body: (field) => `We received the initial card payment for the ${field('billingCadence')} AccountPulse subscription for ${field('organisationName')}.`
  },
  SMS_USAGE_WARNING: {
    subject: 'AccountPulse SMS allowance update',
    body: (field) => `${field('organisationName')} has used ${field('committedParts')} of its ${field('includedParts')} included SMS parts for the period ending ${field('billingPeriodEnd')}. Usage has reached the ${field('warningPercent')}% warning threshold.`
  },
  PAYMENT_FAILED: {
    subject: 'AccountPulse payment failed',
    body: (field) => `The subscription payment of ${field('currency')} ${field('amountMinor')} for ${field('organisationName')} failed. The recovery period ends on ${field('recoveryEndsAt')}.`
  },
  PAYMENT_RECOVERED: {
    subject: 'AccountPulse invoice marked as paid',
    body: (field) => `The subscription invoice for ${field('organisationName')} is now marked as paid.`
  },
  CANCELLATION_SCHEDULED: {
    subject: 'AccountPulse cancellation scheduled',
    body: (field) => `Cancellation of the AccountPulse subscription for ${field('organisationName')} is scheduled for ${field('effectiveAt')}.`
  },
  CANCELLATION_EFFECTIVE: {
    subject: 'AccountPulse subscription cancelled',
    body: (field) => `The AccountPulse subscription for ${field('organisationName')} was cancelled on ${field('cancelledAt')}. The recorded data retention period ends on ${field('dataRetainedUntil')}.`
  },
  EXPORT_DELIVERED: {
    subject: 'AccountPulse export delivery recorded',
    body: (field) => `Export delivery for ${field('organisationName')} was recorded on ${field('completedAt')}. Your request reference is ${field('requestId')}.`
  },
  PRIVACY_REQUEST_RECEIVED: {
    subject: 'AccountPulse privacy request received',
    body: (field) => `Your verified ${field('requestType')} request for ${field('organisationName')} has been received. Your request reference is ${field('requestId')}. The target response date is ${field('targetResponseAt')}.`
  }
} satisfies Record<string, { subject: string; body: (field: ReadField) => string }>;

export function renderLifecycleEmail({ template, templateVersion, renderData }: LifecycleEmailContentInput): RenderedLifecycleEmail {
  if (templateVersion !== 1 || !Object.hasOwn(templates, template)) {
    throw new Error('LIFECYCLE_EMAIL_UNSUPPORTED_TEMPLATE');
  }
  if (renderData === null || typeof renderData !== 'object' || Array.isArray(renderData)) invalid();
  const data = renderData as Record<string, unknown>;
  const entry = templates[template as keyof typeof templates];
  const used = new Set<string>();
  const text = entry.body((field) => {
    if (!Object.hasOwn(data, field)) invalid();
    used.add(field);
    return formatField[field](data[field]);
  });
  if (Object.keys(data).some((key) => !used.has(key))) invalid();
  const htmlText = text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
  return { subject: entry.subject, text, html: `<p>${htmlText}</p>` };
}
