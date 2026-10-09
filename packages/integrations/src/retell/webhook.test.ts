import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { parseRetellWebhook, verifyRetellWebhook } from './webhook.js';

const encoder = new TextEncoder();
const now = new Date('2026-10-07T02:00:00.000Z');
const timestamp = now.getTime();
const apiKey = 'retell-webhook-key';

const signatureFor = (rawBody: Uint8Array, at = timestamp): string => {
  const digest = createHmac('sha256', apiKey)
    .update(rawBody)
    .update(String(at))
    .digest('hex');
  return `v=${at},d=${digest}`;
};

describe('verifyRetellWebhook', () => {
  it('verifies the exact raw bytes plus the millisecond timestamp', () => {
    const rawBody = encoder.encode(
      '{\n  "event": "call_started", "call": {"call_id":"call-1"}\n}'
    );

    expect(
      verifyRetellWebhook({
        rawBody,
        signature: signatureFor(rawBody),
        apiKey,
        now
      })
    ).toBe(true);

    const canonicalised = encoder.encode(
      '{"event":"call_started","call":{"call_id":"call-1"}}'
    );
    expect(
      verifyRetellWebhook({
        rawBody: canonicalised,
        signature: signatureFor(rawBody),
        apiKey,
        now
      })
    ).toBe(false);
  });

  it('rejects stale, future, malformed, duplicate, and invalid signatures', () => {
    const rawBody = encoder.encode('{}');
    const verify = (signature: string) =>
      verifyRetellWebhook({ rawBody, signature, apiKey, now });

    expect(verify(signatureFor(rawBody, timestamp - 300_001))).toBe(false);
    expect(verify(signatureFor(rawBody, timestamp + 300_001))).toBe(false);
    expect(verify('')).toBe(false);
    expect(verify('v=not-a-time,d=00')).toBe(false);
    expect(verify(`v=${timestamp},v=${timestamp},d=${'0'.repeat(64)}`)).toBe(
      false
    );
    expect(verify(`v=${timestamp},d=${'0'.repeat(64)},d=${'1'.repeat(64)}`)).toBe(
      false
    );
    expect(verify(`v=${timestamp},d=${'0'.repeat(63)}`)).toBe(false);
    expect(verify(`v=${timestamp},d=${'0'.repeat(64)}`)).toBe(false);
  });

  it('honours an explicit narrower skew tolerance', () => {
    const rawBody = encoder.encode('{}');
    const signedAt = timestamp - 1_001;

    expect(
      verifyRetellWebhook({
        rawBody,
        signature: signatureFor(rawBody, signedAt),
        apiKey,
        now,
        toleranceMs: 1_000
      })
    ).toBe(false);
  });
});

const encodeEvent = (value: unknown): Uint8Array =>
  encoder.encode(JSON.stringify(value));

describe('parseRetellWebhook', () => {
  it.each([
    ['call_started', 'registered', 1791331200000, undefined],
    ['call_ended', 'ended', 1791331260000, 'user_hangup'],
    ['call_analyzed', 'ended', 1791331260000, 'user_hangup']
  ] as const)(
    'normalises %s without retaining private provider fields',
    (event, callStatus, eventTimestamp, disconnectionReason) => {
      const parsed = parseRetellWebhook(
        encodeEvent({
          event,
          call: {
            call_id: 'call_retell_1',
            call_status: callStatus,
            start_timestamp: 1791331200000,
            end_timestamp:
              event === 'call_started' ? undefined : eventTimestamp,
            disconnection_reason: disconnectionReason,
            transcript: 'private customer speech',
            transcript_object: [{ role: 'user', content: 'private' }],
            recording_url: 'https://example.invalid/private.wav',
            call_analysis:
              event === 'call_analyzed'
                ? {
                    call_summary: 'private summary',
                    in_voicemail: true,
                    call_successful: true,
                    custom_analysis_data: {
                      identity_result: 'confirmed',
                      wrong_person: false,
                      voicemail_left: true,
                      transfer_requested: true,
                      transfer_result: 'bridged',
                      final_result: 'transferred',
                      customer_said: 'private and discarded'
                    }
                  }
                : undefined
          }
        })
      );

      expect(parsed).toMatchObject({
        eventType: event,
        callId: 'call_retell_1',
        callStatus
      });
      expect(parsed.eventKey).toMatch(/^retell:[a-f0-9]{64}$/);
      if (disconnectionReason !== undefined) {
        expect(parsed.disconnectionReason).toBe(disconnectionReason);
      }
      if (event === 'call_analyzed') {
        expect(parsed.analysis).toEqual({
          inVoicemail: true,
          callSuccessful: true,
          structuredOutcome: {
            identityResult: 'confirmed',
            wrongPerson: false,
            voicemailLeft: true,
            transferRequested: true,
            transferResult: 'bridged',
            finalResult: 'transferred'
          }
        });
      }
      expect(JSON.stringify(parsed)).not.toMatch(
        /transcript|recording|summary|customer_said|private/i
      );
    }
  );

  it('creates stable keys that distinguish lifecycle type and timestamp', () => {
    const payload = {
      event: 'call_ended',
      call: {
        call_id: 'call-key',
        call_status: 'ended',
        start_timestamp: 100,
        end_timestamp: 200
      }
    };
    const first = parseRetellWebhook(encodeEvent(payload));
    const duplicate = parseRetellWebhook(encodeEvent(payload));
    const later = parseRetellWebhook(
      encodeEvent({
        ...payload,
        call: { ...payload.call, end_timestamp: 201 }
      })
    );
    const analyzed = parseRetellWebhook(
      encodeEvent({ ...payload, event: 'call_analyzed' })
    );

    expect(duplicate.eventKey).toBe(first.eventKey);
    expect(later.eventKey).not.toBe(first.eventKey);
    expect(analyzed.eventKey).not.toBe(first.eventKey);
  });

  it.each(['transcript_updated', 'transfer_started', 'chat_started']) (
    'rejects unsupported event %s',
    (event) => {
      expect(() =>
        parseRetellWebhook(
          encodeEvent({
            event,
            call: { call_id: 'call-1', call_status: 'ongoing' }
          })
        )
      ).toThrow('RETELL_WEBHOOK_EVENT_UNSUPPORTED');
    }
  );

  it('rejects malformed JSON and malformed calls', () => {
    expect(() => parseRetellWebhook(encoder.encode('{'))).toThrow(
      'RETELL_WEBHOOK_INVALID_JSON'
    );
    expect(() =>
      parseRetellWebhook(
        encodeEvent({ event: 'call_started', call: { call_status: 'ongoing' } })
      )
    ).toThrow('RETELL_WEBHOOK_INVALID_CALL');
  });
});
