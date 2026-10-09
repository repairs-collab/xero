import { describe, expect, it } from 'vitest';

import { jobNames } from './names.js';
import {
  parseJobPayload,
  type VoiceCallExecutePayload,
  type VoiceCallReconcilePayload
} from './payloads.js';

describe('voice call job contracts', () => {
  it('publishes stable execute and reconcile job names', () => {
    expect(jobNames.voiceRemindersCalculate).toBe(
      'voice-reminders.calculate'
    );
    expect(jobNames.voiceRemindersDispatch).toBe(
      'voice-reminders.dispatch'
    );
    expect(jobNames.voiceCallExecute).toBe('voice-call.execute');
    expect(jobNames.voiceCallReconcile).toBe('voice-call.reconcile');
  });

  it('parses identifier-only voice calculation payloads', () => {
    expect(
      parseJobPayload(jobNames.voiceRemindersCalculate, {
        organisationId: 'org-1'
      })
    ).toEqual({ organisationId: 'org-1' });
    expect(
      parseJobPayload(jobNames.voiceRemindersDispatch, {
        organisationId: 'org-1'
      })
    ).toEqual({ organisationId: 'org-1' });
  });

  it('parses identifier-only execute and reconcile payloads', () => {
    const execute: VoiceCallExecutePayload = {
      organisationId: 'org-1',
      voiceCallId: 'call-1',
      provider: 'VOIPCLOUD',
      correlationId: 'correlation-1'
    };
    const reconcile: VoiceCallReconcilePayload = {
      organisationId: 'org-1',
      voiceCallId: 'call-1',
      provider: 'VOIPCLOUD',
      correlationId: 'correlation-2'
    };

    expect(parseJobPayload(jobNames.voiceCallExecute, execute)).toEqual(
      execute
    );
    expect(parseJobPayload(jobNames.voiceCallReconcile, reconcile)).toEqual(
      reconcile
    );
    expect(
      parseJobPayload(jobNames.webhookProcess, {
        organisationId: 'org-1',
        webhookEventId: 'webhook-1',
        provider: 'VOIPCLOUD'
      })
    ).toEqual({
      organisationId: 'org-1',
      webhookEventId: 'webhook-1',
      provider: 'VOIPCLOUD'
    });
    expect(() =>
      parseJobPayload(jobNames.voiceCallExecute, {
        organisationId: 'org-1',
        voiceCallId: 'call-1',
        provider: 'RETELL'
      })
    ).toThrow();
  });

  it.each([
    ['script', 'Do not store this script'],
    ['destinationNumber', '+61400000000'],
    ['combinedAmount', '100.00'],
    ['retellApiKey', 'secret-value'],
    ['transcript', 'customer speech']
  ])('rejects forbidden %s data in a voice job payload', (field, value) => {
    expect(() =>
      parseJobPayload(jobNames.voiceCallExecute, {
        organisationId: 'org-1',
        voiceCallId: 'call-1',
        [field]: value
      })
    ).toThrow();
  });
});
