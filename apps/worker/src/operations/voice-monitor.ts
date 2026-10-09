export interface VoiceMonitorSnapshot {
  voiceUnknownOutcomesTotal: number;
  voiceProviderFailuresTotal: number;
  voiceQueueAgeSeconds: number;
  retellWebhookLagSeconds: number;
}

export interface VoiceMonitorThresholds {
  queueAgeSeconds: number;
  webhookLagSeconds: number;
}

export type VoiceMonitorAlarm =
  | 'VOICE_UNKNOWN_OUTCOME'
  | 'VOICE_PROVIDER_FAILURE'
  | 'VOICE_QUEUE_AGE_HIGH'
  | 'RETELL_WEBHOOK_LAG_HIGH';

export function evaluateVoiceMonitor(
  snapshot: VoiceMonitorSnapshot,
  thresholds: VoiceMonitorThresholds
) {
  const alarms: VoiceMonitorAlarm[] = [];
  if (snapshot.voiceUnknownOutcomesTotal > 0) {
    alarms.push('VOICE_UNKNOWN_OUTCOME');
  }
  if (snapshot.voiceProviderFailuresTotal > 0) {
    alarms.push('VOICE_PROVIDER_FAILURE');
  }
  if (snapshot.voiceQueueAgeSeconds > thresholds.queueAgeSeconds) {
    alarms.push('VOICE_QUEUE_AGE_HIGH');
  }
  if (snapshot.retellWebhookLagSeconds > thresholds.webhookLagSeconds) {
    alarms.push('RETELL_WEBHOOK_LAG_HIGH');
  }
  return {
    healthy: alarms.length === 0,
    alarms,
    metrics: [
      {
        metric: 'voice_unknown_outcomes_total' as const,
        value: snapshot.voiceUnknownOutcomesTotal
      },
      {
        metric: 'voice_provider_failures_total' as const,
        value: snapshot.voiceProviderFailuresTotal
      },
      {
        metric: 'voice_queue_age_seconds' as const,
        value: snapshot.voiceQueueAgeSeconds
      },
      {
        metric: 'retell_webhook_lag_seconds' as const,
        value: snapshot.retellWebhookLagSeconds
      }
    ]
  };
}
