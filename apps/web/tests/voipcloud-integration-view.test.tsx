import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { VoiceSettingsForm } from '../src/app/(protected)/settings/voice/voice-settings-form.js';
import type { VoiceSettingsView } from '../src/app/(protected)/settings/voice/voice-settings.js';
import { VoiceTestCallPanel } from '../src/app/(protected)/settings/voice/voice-test-call-panel.js';

const settings = {
  configured: true,
  enabled: false,
  automaticEnabled: false,
  provider: 'VOIPCLOUD',
  secretReferenceLabel: 'VOIPCLOUD_API_KEY',
  previewPublicKey: null,
  agentId: null,
  agentVersion: null,
  voiceId: null,
  voiceLabel: null,
  voipcloudUserNumber: '1099',
  ttsVoiceId: 'en_GB-alba-medium',
  gatewayFlowVersion: 1,
  outboundNumber: '+61350324518',
  transferSipUri: 'sip:1003@asterisk',
  fallbackOfficeNumber: '+61350324518',
  officeDestinationLabel: 'Main office queue — Tab 1',
  timezone: 'Australia/Sydney',
  weekdayStartLocal: '09:00',
  weekdayEndLocal: '17:00',
  configurationVersion: 4,
  callFlowVersion: 1,
  callFlowHash: 'sha256:flow',
  connectionReady: false,
  gatewayReady: false,
  genericFlowReady: false,
  lastConnectionTestedAt: null,
  lastGatewayTestedAt: null
} as VoiceSettingsView;

describe('VoIPcloud settings experience', () => {
  it('shows a dedicated Australian VoIPcloud integration without Retell credentials', () => {
    const html = renderToStaticMarkup(
      createElement(VoiceSettingsForm, {
        organisationId: 'org-1',
        settings
      })
    );

    expect(html).toContain('VoIPcloud integration');
    expect(html).toContain('Australian VoIPcloud API');
    expect(html).toContain('Credentials secured on OVH');
    expect(html).toContain('name="voipcloudUserNumber"');
    expect(html).toContain('name="ttsVoiceId"');
    expect(html).toContain('name="gatewayFlowVersion"');
    expect(html).toContain('Test VoIPcloud and gateway');
    expect(html).not.toMatch(/retell|previewPublicKey|agentId|agentVersion/i);
    expect(html).not.toContain('name="secretReference"');
  });

  it('keeps test-call entry fields editable while clearly gating submission', () => {
    const html = renderToStaticMarkup(
      createElement(VoiceTestCallPanel, {
        organisationId: 'org-1',
        ready: false,
        idempotencyKey: 'test-key',
        draft: null,
        prepareAction: () => Promise.resolve(),
        approveAction: () => Promise.resolve()
      })
    );

    expect(html).toMatch(/<input[^>]*name="invoiceNumber"[^>]*>/);
    expect(html).toMatch(/<input[^>]*name="testNumber"[^>]*>/);
    expect(html).not.toMatch(/<input[^>]*name="(?:invoiceNumber|testNumber)"[^>]*disabled/);
    expect(html).toContain('Test VoIPcloud and the gateway first');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Review test call<\/button>/);
  });
});
