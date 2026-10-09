import { describe, expect, it } from 'vitest';

import {
  groupVoiceSequenceCandidates,
  nextVoiceDispatchAt,
  voiceSequenceIdempotencyKey,
  type VoiceSequenceGroupingInput
} from './voice-sequences.js';

const groupingInput = (
  invoices: VoiceSequenceGroupingInput['invoices']
): VoiceSequenceGroupingInput => ({
  organisationId: 'organisation-1',
  sequenceVersionId: 'sequence-version-1',
  stageKey: 'twenty-one-days',
  localOccurrenceDate: '2026-10-09',
  invoices
});

describe('groupVoiceSequenceCandidates', () => {
  it('consolidates a customer occurrence and includes each invoice once', () => {
    const result = groupVoiceSequenceCandidates(
      groupingInput([
        {
          invoiceId: 'invoice-2',
          customerId: 'customer-1',
          amountDue: '40.25',
          currency: 'AUD'
        },
        {
          invoiceId: 'invoice-1',
          customerId: 'customer-1',
          amountDue: '60.00',
          currency: 'AUD'
        },
        {
          invoiceId: 'invoice-1',
          customerId: 'customer-1',
          amountDue: '60.00',
          currency: 'AUD'
        }
      ])
    );

    expect(result).toEqual([
      {
        organisationId: 'organisation-1',
        sequenceVersionId: 'sequence-version-1',
        stageKey: 'twenty-one-days',
        customerId: 'customer-1',
        localOccurrenceDate: '2026-10-09',
        currency: 'AUD',
        combinedAmount: '100.25',
        invoices: [
          {
            invoiceId: 'invoice-1',
            customerId: 'customer-1',
            amountDue: '60.00',
            currency: 'AUD'
          },
          {
            invoiceId: 'invoice-2',
            customerId: 'customer-1',
            amountDue: '40.25',
            currency: 'AUD'
          }
        ]
      }
    ]);
  });

  it('keeps customers and currencies separate in deterministic order', () => {
    const invoices = [
      {
        invoiceId: 'invoice-nzd',
        customerId: 'customer-a',
        amountDue: '30.00',
        currency: 'NZD'
      },
      {
        invoiceId: 'invoice-b',
        customerId: 'customer-b',
        amountDue: '20.00',
        currency: 'AUD'
      },
      {
        invoiceId: 'invoice-a',
        customerId: 'customer-a',
        amountDue: '10.00',
        currency: 'AUD'
      }
    ] as const;

    const forward = groupVoiceSequenceCandidates(groupingInput(invoices));
    const reverse = groupVoiceSequenceCandidates(
      groupingInput([...invoices].reverse())
    );

    expect(reverse).toEqual(forward);
    expect(forward.map(({ customerId, currency }) => [customerId, currency]))
      .toEqual([
        ['customer-a', 'AUD'],
        ['customer-a', 'NZD'],
        ['customer-b', 'AUD']
      ]);
  });

  it('builds the idempotency key from every occurrence dimension', () => {
    const [candidate] = groupVoiceSequenceCandidates(
      groupingInput([
        {
          invoiceId: 'invoice-1',
          customerId: 'customer-1',
          amountDue: '10.00',
          currency: 'AUD'
        }
      ])
    );

    expect(candidate && voiceSequenceIdempotencyKey(candidate)).toBe(
      'voice-sequence:organisation-1:sequence-version-1:twenty-one-days:customer-1:2026-10-09:AUD'
    );
  });
});

describe('nextVoiceDispatchAt', () => {
  it('uses the beginning of the next Sydney weekday after cooldown crosses the window', () => {
    expect(
      nextVoiceDispatchAt({
        requestedAt: new Date('2026-10-09T05:59:00.000Z'),
        lastCompletedAt: new Date('2026-10-09T05:59:00.000Z'),
        cooldownSeconds: 120,
        timezone: 'Australia/Sydney',
        holidays: [],
        weekdayStartLocal: '09:00',
        weekdayEndLocal: '17:00'
      }).toISOString()
    ).toBe('2026-10-11T22:00:00.000Z');
  });

  it('waits until the weekday window opens and skips local holidays', () => {
    expect(
      nextVoiceDispatchAt({
        requestedAt: new Date('2026-10-11T20:00:00.000Z'),
        lastCompletedAt: null,
        cooldownSeconds: 60,
        timezone: 'Australia/Sydney',
        holidays: ['2026-10-12'],
        weekdayStartLocal: '09:00',
        weekdayEndLocal: '17:00'
      }).toISOString()
    ).toBe('2026-10-12T22:00:00.000Z');
  });
});
