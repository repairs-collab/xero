import { headers } from 'next/headers';
import Link from 'next/link';
import Script from 'next/script';

import {
  getDatabaseClient,
  getVoiceProviderTester,
  issueVoicePreviewSession,
  requireWebSession,
  verifyVoicePreviewSession
} from '../../../../server/runtime.js';
import { GenericFlowPreview } from './generic-flow-preview.js';
import { createVoiceSettingsService } from './voice-settings.js';
import { VoiceSettingsForm } from './voice-settings-form.js';

export default async function VoiceSettingsPage() {
  const session = await requireWebSession(
    new Request('http://localhost/', { headers: await headers() })
  );
  const organisationId = session.memberships[0]?.organisationId;
  if (organisationId === undefined) {
    throw new Error('No active organisation membership');
  }
  const settingsService = createVoiceSettingsService({
    database: getDatabaseClient().db,
    session,
    tester: getVoiceProviderTester(),
    previewSessions: { verify: verifyVoicePreviewSession },
    clock: { now: () => new Date() }
  });
  const settings = await settingsService.get(organisationId);
  const previewSession =
    settings.configured &&
    settings.agentId !== null &&
    settings.agentVersion !== null &&
    settings.voiceId !== null
      ? issueVoicePreviewSession({
          organisationId,
          userId: session.userId,
          callFlowHash: settings.callFlowHash,
          callFlowVersion: settings.callFlowVersion,
          configurationVersion: settings.configurationVersion,
          agentId: settings.agentId,
          agentVersion: settings.agentVersion,
          voiceId: settings.voiceId
        })
      : null;
  const recaptchaSiteKey = process.env.NEXT_PUBLIC_RECAPTCHA_SITE_KEY ?? null;

  return (
    <div className="page-stack voice-settings-page">
      {recaptchaSiteKey !== null ? (
        <Script
          src={`https://www.google.com/recaptcha/api.js?render=${encodeURIComponent(recaptchaSiteKey)}`}
          strategy="afterInteractive"
        />
      ) : null}
      <Link className="back-link" href="/settings">
        ← Back to settings
      </Link>
      <header className="page-heading">
        <span className="eyebrow">Administrator voice setup</span>
        <h1>Voice reminders</h1>
        <p>
          Configure the locked generic call flow, test it with fictional data,
          then enable manual customer calls separately.
        </p>
      </header>

      <VoiceSettingsForm
        organisationId={organisationId}
        settings={settings}
      />

      {previewSession !== null &&
      settings.previewPublicKey !== null &&
      settings.agentId !== null &&
      settings.agentVersion !== null ? (
        <GenericFlowPreview
          organisationId={organisationId}
          previewPublicKey={settings.previewPublicKey}
          agentId={settings.agentId}
          agentVersion={settings.agentVersion}
          previewSessionId={previewSession.sessionId}
          previewSessionToken={previewSession.token}
          recaptchaSiteKey={recaptchaSiteKey}
        />
      ) : (
        <section className="panel">
          <span className="eyebrow">Fictional setup preview</span>
          <h2>Save the provider settings first</h2>
          <p>No customer call can be placed from this setup preview.</p>
        </section>
      )}
    </div>
  );
}
