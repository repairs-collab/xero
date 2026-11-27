import { expect, it } from 'vitest';
import { renderLifecycleEmail } from './templates.js';

const day = '2026-10-31';
const org = { organisationName: 'Waratah Works' };
const usage = { ...org, committedParts: 817, includedParts: 1000, warningPercent: 80, billingPeriodEnd: day };
const failed = { ...org, amountMinor: 12345, currency: 'aud', recoveryEndsAt: day };
const privacy = { ...org, requestId: 'REQ-412', requestType: 'DELETION', targetResponseAt: day };

const cases = [
  ['WORKSPACE_WELCOME', org, /workspace.*ready/i, []],
  ['ONBOARDING_COMPLETED', org, /onboarding.*complete/i, []],
  ['PAYMENT_CONFIRMED', { ...org, billingCadence: 'MONTHLY' }, /initial card payment/i, ['monthly']],
  ['SMS_USAGE_WARNING', usage, /sms/i, ['817', '1,000', '80%', '31 Oct 2026']],
  ['PAYMENT_FAILED', failed, /payment.*failed/i, ['AUD 123.45', '31 Oct 2026']],
  ['PAYMENT_RECOVERED', org, /The subscription invoice for Waratah Works is now marked as paid\./, []],
  ['CANCELLATION_SCHEDULED', { ...org, effectiveAt: day }, /cancellation.*scheduled/i, ['31 Oct 2026']],
  ['CANCELLATION_EFFECTIVE', { ...org, cancelledAt: day, dataRetainedUntil: '2026-11-30' }, /cancelled/i, ['31 Oct 2026', '30 Nov 2026']],
  ['EXPORT_DELIVERED', { ...org, requestId: 'REQ-311', completedAt: day }, /export delivery.*recorded/i, ['REQ-311', '31 Oct 2026']],
  ['PRIVACY_REQUEST_RECEIVED', privacy, /request.*received/i, ['REQ-412', 'deletion', '31 Oct 2026']]
] as const;

it.each(cases)('renders the proven details of %s in both formats', (template, renderData, fact, details) => {
  const { subject, text, html } = renderLifecycleEmail({ template, templateVersion: 1, renderData });
  for (const body of [text, html]) {
    expect(body).toMatch(fact);
    expect(body).toContain('Waratah Works');
    for (const detail of details) expect(body).toContain(detail);
  }
  expect(subject.trim()).not.toBe('');
  expect(subject).not.toMatch(/REQ-|Waratah Works/);
  expect(html).toContain('<p>');
  expect(text).not.toContain('<p>');
});

it('describes the recorded invoice status in the payment recovery subject', () => {
  const { subject } = renderLifecycleEmail({ template: 'PAYMENT_RECOVERED', templateVersion: 1, renderData: org });
  expect(subject).toBe('AccountPulse invoice marked as paid');
});

it('escapes organisation text in HTML and keeps original characters in the text alternative', () => {
  const organisationName = `<svg onload="alert('1')"> &amp;`;
  const { text, html, subject } = renderLifecycleEmail({
    template: 'WORKSPACE_WELCOME', templateVersion: 1, renderData: { organisationName }
  });
  expect(html).toContain('&lt;svg onload=&quot;alert(&#39;1&#39;)&quot;&gt; &amp;amp;');
  expect(text).toContain(organisationName);
  expect(subject).not.toContain(organisationName);
});

it('retains the time and zone of a dated deadline', () => {
  const { text } = renderLifecycleEmail({ template: 'PAYMENT_FAILED', templateVersion: 1,
    renderData: { ...failed, recoveryEndsAt: '2026-10-31T18:35:00.000Z' } });
  expect(text).toMatch(/31 Oct 2026.*18:35.*UTC/);
});

it.each(cases)('requires every field of %s and rejects unapproved fields', (template, fields) => {
  const render = (renderData: unknown) => renderLifecycleEmail({ template, templateVersion: 1, renderData });
  for (const key of Object.keys(fields)) {
    const partial = { ...fields } as Record<string, unknown>;
    delete partial[key];
    expect(() => render(partial)).toThrow('LIFECYCLE_EMAIL_INVALID_RENDER_DATA');
    expect(() => render({ ...fields, [key]: true })).toThrow('LIFECYCLE_EMAIL_INVALID_RENDER_DATA');
  }
  expect(() => render({ ...fields, providerPayload: 'private response' })).toThrow(/^LIFECYCLE_EMAIL_INVALID_RENDER_DATA$/);
});

it.each([
  ['WORKSPACE_WELCOME', null], ['WORKSPACE_WELCOME', []], ['WORKSPACE_WELCOME', { organisationName: ' ' }],
  ['WORKSPACE_WELCOME', { organisationName: 'First\r\nBcc: private@example.test' }],
  ['PAYMENT_CONFIRMED', { ...org, billingCadence: 'weekly' }],
  ['PAYMENT_RECOVERED', { ...org, amountMinor: 7, currency: 'AUD' }],
  ['PAYMENT_FAILED', { ...failed, amountMinor: -1 }], ['PAYMENT_FAILED', { ...failed, amountMinor: 1.5 }],
  ['PAYMENT_FAILED', { ...failed, amountMinor: Number.MAX_SAFE_INTEGER + 1 }], ['PAYMENT_FAILED', { ...failed, currency: 'USD' }],
  ['PAYMENT_FAILED', { ...failed, recoveryEndsAt: '2026-02-30' }], ['PAYMENT_FAILED', { ...failed, recoveryEndsAt: '10/31/2026' }],
  ['SMS_USAGE_WARNING', { ...usage, committedParts: -1 }], ['SMS_USAGE_WARNING', { ...usage, includedParts: 0 }],
  ['SMS_USAGE_WARNING', { ...usage, warningPercent: 0 }], ['SMS_USAGE_WARNING', { ...usage, warningPercent: 101 }],
  ['PRIVACY_REQUEST_RECEIVED', { ...privacy, requestType: 'EXPORT_ARCHIVE' }],
  ['PRIVACY_REQUEST_RECEIVED', { ...privacy, requestId: 'https://private.example/export' }]
])('rejects invalid values for %s', (template, renderData) => {
  expect(() => renderLifecycleEmail({ template: String(template), templateVersion: 1, renderData }))
    .toThrow(/^LIFECYCLE_EMAIL_INVALID_RENDER_DATA$/);
});

it.each([['WORKSPACE_WELCOME', 2], ['toString', 1], ['DELETION_COMPLETED', 1]] as const)(
  'rejects unsupported template or version %s v%i', (template, templateVersion) => {
    expect(() => renderLifecycleEmail({ template, templateVersion, renderData: org }))
      .toThrow(/^LIFECYCLE_EMAIL_UNSUPPORTED_TEMPLATE$/);
  }
);
