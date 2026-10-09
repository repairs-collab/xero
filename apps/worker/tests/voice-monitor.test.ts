import { describe, expect, it } from 'vitest';

import { evaluateVoiceMonitor } from '../src/operations/voice-monitor.js';

describe('voice operational monitor', () => {
  it('emits the release metrics and alarms on unsafe voice conditions', () => {
    const result = evaluateVoiceMonitor(
      {
        voiceUnknownOutcomesTotal: 1,
        voiceProviderFailuresTotal: 0,
        voiceQueueAgeSeconds: 301,
        retellWebhookLagSeconds: 0
      },
      { queueAgeSeconds: 300, webhookLagSeconds: 300 }
    );

    expect(result.metrics).toEqual([
      { metric: 'voice_unknown_outcomes_total', value: 1 },
      { metric: 'voice_provider_failures_total', value: 0 },
      { metric: 'voice_queue_age_seconds', value: 301 },
      { metric: 'retell_webhook_lag_seconds', value: 0 }
    ]);
    expect(result.healthy).toBe(false);
    expect(result.alarms).toEqual([
      'VOICE_UNKNOWN_OUTCOME',
      'VOICE_QUEUE_AGE_HIGH'
    ]);
  });

  it('is healthy when no unknown/failure outcome or queue lag exceeds a threshold', () => {
    expect(
      evaluateVoiceMonitor(
        {
          voiceUnknownOutcomesTotal: 0,
          voiceProviderFailuresTotal: 0,
          voiceQueueAgeSeconds: 15,
          retellWebhookLagSeconds: 10
        },
        { queueAgeSeconds: 300, webhookLagSeconds: 300 }
      )
    ).toMatchObject({ healthy: true, alarms: [] });
  });
});
