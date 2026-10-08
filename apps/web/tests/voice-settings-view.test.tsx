import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { fixedVoiceCallCopy } from '@bc5000/domain';

import {
  createGenericFlowPreviewConfiguration,
  GenericFlowPreview
} from '../src/app/(protected)/settings/voice/generic-flow-preview.js';
import { VoiceSettingsForm } from '../src/app/(protected)/settings/voice/voice-settings-form.js';
import type { VoiceSettingsView } from '../src/app/(protected)/settings/voice/voice-settings.js';
import { settingsCardsForRole } from '../src/app/(protected)/settings/settings-cards.js';
import {
  issueVoicePreviewSession,
  verifyVoicePreviewSession
} from '../src/server/runtime.js';

const configuredSettings: VoiceSettingsView = {
  configured: true,
  enabled: false,
  provider: 'RETELL',
  secretReferenceLabel: 'RETELL_API_KEY',
  previewPublicKey: 'public_key_accountpulse_preview',
  agentId: 'agent_accountpulse',
  agentVersion: 7,
  voiceId: 'voice_australian_1',
  voiceLabel: 'Australian accounts voice',
  outboundNumber: '+61255501234',
  transferSipUri: 'sip:accounts@voipline.example',
  fallbackOfficeNumber: '+61255504321',
  officeDestinationLabel: 'Main office accounts queue',
  timezone: 'Australia/Sydney',
  weekdayStartLocal: '09:00',
  weekdayEndLocal: '17:00',
  configurationVersion: 1,
  callFlowVersion: fixedVoiceCallCopy.version,
  callFlowHash: 'sha256:fixed-flow',
  connectionReady: true,
  genericFlowReady: false,
  lastConnectionTestedAt: new Date('2026-10-08T02:00:00.000Z')
};

describe('voice settings view', () => {
  it('shows the voice settings entry only to Administrators', () => {
    expect(settingsCardsForRole('ADMIN').map((card) => card.href)).toContain(
      '/settings/voice'
    );
    expect(settingsCardsForRole('OPERATOR').map((card) => card.href)).not.toContain(
      '/settings/voice'
    );
  });

  it('separates manual-call enablement from provider and generic-flow readiness', () => {
    const html = renderToStaticMarkup(
      createElement(VoiceSettingsForm, {
        organisationId: 'org-1',
        settings: configuredSettings
      })
    );

    expect(html).toContain('Manual voice calls are off');
    expect(html).toContain('Provider readiness');
    expect(html).toContain('Connection ready');
    expect(html).toContain('Generic flow test required');
    expect(html).toContain('manual, one-at-a-time voice calls');
    expect(html).toContain('Customer Live SMS and email remain unchanged');
    expect(html).toContain('ENABLE VOICE CALLS');
    expect(html).toContain('RETELL_API_KEY');
    expect(html).not.toContain('env:RETELL_API_KEY');
    expect(html).not.toMatch(/private key|api key value|authorization:/i);
  });

  it('shows the locked opening and voicemail as non-editable call-flow copy', () => {
    const html = renderToStaticMarkup(
      createElement(VoiceSettingsForm, {
        organisationId: 'org-1',
        settings: configuredSettings
      })
    );

    expect(html).toContain(
      fixedVoiceCallCopy.opening.replaceAll('"', '&quot;')
    );
    expect(html).toContain(fixedVoiceCallCopy.voicemail);
    expect(html).not.toContain(`name="opening"`);
    expect(html).not.toContain(`name="voicemail"`);
  });

  it('builds a fictional web-audio preview with transcript, outbound calling, and transfer disabled', () => {
    const configuration = createGenericFlowPreviewConfiguration({
      agentId: 'agent_accountpulse',
      agentVersion: 7,
      previewSessionId: 'preview-session-123',
      recaptchaToken: 'fresh-recaptcha-token'
    });

    expect(configuration).toEqual({
      agent_id: 'agent_accountpulse',
      agent_version: 7,
      transcript: false,
      recaptchaToken: 'fresh-recaptcha-token',
      metadata: {
        accountpulse_preview_session_id: 'preview-session-123'
      },
      retell_llm_dynamic_variables: {
        accountpulse_call_id: 'preview-preview-session-123',
        preview_mode: 'true',
        disable_outbound_call: 'true',
        disable_transfer: 'true',
        invoice_details_json:
          '[{"invoiceNumber":"DEMO-1001","amountDue":"120.50"},{"invoiceNumber":"DEMO-1002","amountDue":"80.05"}]',
        combined_amount: '200.55',
        currency: 'AUD',
        callback_number: '+61200000000',
        fallback_office_number: '+61200000000'
      }
    });
    const serialised = JSON.stringify(configuration);
    expect(serialised).not.toMatch(
      /customer[_ ]?id|customer[_ ]?name|to_number|destination|transfer_sip|recording|audio|onTranscript/i
    );
  });

  it('labels the browser preview as fictional and does not ask for a customer or telephone number', () => {
    const html = renderToStaticMarkup(
      createElement(GenericFlowPreview, {
        organisationId: 'org-1',
        previewPublicKey: 'public_key_accountpulse_preview',
        agentId: 'agent_accountpulse',
        agentVersion: 7,
        previewSessionId: 'preview-session-123',
        previewSessionToken: 'signed-preview-session-token',
        recaptchaSiteKey: 'recaptcha-site-key'
      })
    );

    expect(html).toContain('Fictional setup preview');
    expect(html).toContain('DEMO-1001');
    expect(html).toContain('No customer will be called');
    expect(html).toContain('No transcript or recording is kept');
    expect(html).not.toMatch(/name="customer|name="phone|name="destination/i);
  });

  it('accepts only an untampered server-issued preview session for the pinned flow', async () => {
    const previousSecret = process.env.SESSION_SECRET_BASE64;
    process.env.SESSION_SECRET_BASE64 = Buffer.alloc(32, 7).toString('base64');
    try {
      const expected = {
        organisationId: 'org-1',
        userId: 'user-1',
        callFlowHash: 'sha256:fixed-flow',
        callFlowVersion: 1,
        configurationVersion: 3,
        agentId: 'agent_accountpulse',
        agentVersion: 7,
        voiceId: 'voice_australian_1'
      };
      const issued = issueVoicePreviewSession(expected);

      await expect(
        verifyVoicePreviewSession({
          ...expected,
          previewSessionToken: issued.token
        })
      ).resolves.toEqual({ sessionId: issued.sessionId, passed: true });

      expect(() =>
        verifyVoicePreviewSession({
          ...expected,
          previewSessionToken: `${issued.token}tampered`
        })
      ).toThrow('VOICE_PREVIEW_SESSION_INVALID');

      expect(() =>
        verifyVoicePreviewSession({
          ...expected,
          configurationVersion: 4,
          previewSessionToken: issued.token
        })
      ).toThrow('VOICE_PREVIEW_SESSION_INVALID');
    } finally {
      if (previousSecret === undefined) delete process.env.SESSION_SECRET_BASE64;
      else process.env.SESSION_SECRET_BASE64 = previousSecret;
    }
  });
});
