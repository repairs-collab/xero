'use client';

import { useMemo, useState } from 'react';
import { parsePhoneNumberFromString } from 'libphonenumber-js';

import { renderSms } from '@bc5000/domain';

import { queueTestSms } from '../app/(protected)/settings/test-sms/actions.js';

const DEFAULT_MESSAGE = 'AccountPulse test message — no action is required.';

export interface TestSmsPreview {
  encoding: 'GSM-7' | 'UCS-2' | null;
  segmentCount: number;
  error: string | null;
}

export const createTestSmsPreview = (content: string): TestSmsPreview => {
  if (content.trim() === '') {
    return {
      encoding: null,
      segmentCount: 0,
      error: 'Enter a message to preview its SMS length.'
    };
  }
  try {
    const rendered = renderSms(content, {}, { maxSegments: 3 });
    return {
      encoding: rendered.encoding,
      segmentCount: rendered.segmentCount,
      error: null
    };
  } catch (error) {
    return {
      encoding: null,
      segmentCount: 0,
      error:
        error instanceof Error && error.message.includes('segment limit')
          ? 'This message exceeds the 3-segment test limit.'
          : 'This message cannot be sent as an SMS.'
    };
  }
};

const validAustralianNumber = (value: string): boolean => {
  const parsed = parsePhoneNumberFromString(value.trim(), 'AU');
  return parsed?.country === 'AU' && parsed.isValid();
};

export function TestSmsForm({
  organisationId,
  requestId,
  sendMode
}: {
  organisationId: string;
  requestId: string;
  sendMode: 'dry-run' | 'live';
}) {
  const [destination, setDestination] = useState('');
  const [content, setContent] = useState(DEFAULT_MESSAGE);
  const preview = useMemo(() => createTestSmsPreview(content), [content]);
  const phoneIsValid = validAustralianNumber(destination);

  return (
    <form action={queueTestSms} className="test-sms-form">
      <input type="hidden" name="organisationId" value={organisationId} />
      <input type="hidden" name="requestId" value={requestId} />

      <div
        className={
          sendMode === 'live'
            ? 'test-sms-safety test-sms-safety--live'
            : 'test-sms-safety'
        }
      >
        <strong>
          {sendMode === 'live' ? 'Live-send safeguards apply' : 'Dry-run mode is active'}
        </strong>
        <p>
          {sendMode === 'live'
            ? 'Only a number on the technical recipient allowlist can receive this SMS. Every other test is recorded as a dry run.'
            : 'No SMS will be sent to a phone while dry-run mode is active. The test will still appear in Outbox.'}
        </p>
      </div>

      <label>
        Australian mobile number
        <input
          name="destination"
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          placeholder="0400 000 000"
          value={destination}
          onChange={(event) => setDestination(event.target.value)}
          required
        />
        <small className={destination === '' || phoneIsValid ? '' : 'field-error'}>
          {destination === ''
            ? 'Enter the number that should receive the test.'
            : phoneIsValid
              ? 'Valid Australian number'
              : 'Enter a valid Australian number.'}
        </small>
      </label>

      <label>
        Message
        <textarea
          name="content"
          rows={6}
          value={content}
          onChange={(event) => setContent(event.target.value)}
          required
        />
      </label>

      <div
        className={preview.error === null ? 'sms-preview' : 'sms-preview sms-preview--error'}
        aria-live="polite"
      >
        {preview.error === null ? (
          <>
            <span>
              <small>Encoding</small>
              <strong>{preview.encoding}</strong>
            </span>
            <span>
              <small>Segments</small>
              <strong>{preview.segmentCount} of 3</strong>
            </span>
          </>
        ) : (
          <p>{preview.error}</p>
        )}
      </div>

      <label className="manual-confirmation">
        <input name="confirmed" type="checkbox" value="yes" required />
        I confirm this test SMS is ready and the number is correct
      </label>
      <button
        className="button button--primary"
        type="submit"
        disabled={!phoneIsValid || preview.error !== null}
      >
        Queue test SMS
      </button>
      <small className="test-sms-outbox-note">
        Outbox is the source of truth for the final delivery result.
      </small>
    </form>
  );
}
