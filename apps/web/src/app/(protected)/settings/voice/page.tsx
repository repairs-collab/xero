import { randomUUID } from 'node:crypto';

import { headers } from 'next/headers';
import Link from 'next/link';
import Script from 'next/script';

import { PostgresVoiceCallRepository } from '@bc5000/db/web';

import { getJobQueue } from '../../../../server/job-runtime.js';
import {
  getDatabaseClient,
  getVoiceProviderTester,
  issueVoicePreviewSession,
  requireWebSession,
  verifyVoicePreviewSession
} from '../../../../server/runtime.js';
import { GenericFlowPreview } from './generic-flow-preview.js';
import {
  approveVoiceTestCall,
  prepareVoiceTestCall
} from './actions.js';
import { createVoiceSettingsService } from './voice-settings.js';
import { VoiceSettingsForm } from './voice-settings-form.js';
import { VoiceTestCallPanel } from './voice-test-call-panel.js';
import { createVoiceTestCallService } from './voice-test-call-service.js';
import { FreeVoiceFlowPreview } from './free-voice-flow-preview.js';

export default async function VoiceSettingsPage({
  searchParams
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const session = await requireWebSession(
    new Request('http://localhost/', { headers: await headers() })
  );
  const organisationId = session.memberships[0]?.organisationId;
  if (organisationId === undefined) {
    throw new Error('No active organisation membership');
  }
  const database = getDatabaseClient().db;
  const settingsService = createVoiceSettingsService({
    database,
    session,
    tester: getVoiceProviderTester(),
    previewSessions: { verify: verifyVoicePreviewSession },
    clock: { now: () => new Date() }
  });
  const settings = await settingsService.get(organisationId);
  const testVoiceCallParameter = query.testVoiceCall;
  const testVoiceCallId = Array.isArray(testVoiceCallParameter)
    ? testVoiceCallParameter[0]
    : testVoiceCallParameter;
  const testVoiceCallService = createVoiceTestCallService({
    database,
    repository: new PostgresVoiceCallRepository(database),
    publisher: await getJobQueue(),
    session,
    clock: { now: () => new Date() },
    holidays: { list: () => [] }
  });
  const testVoiceCallDraft =
    testVoiceCallId === undefined || testVoiceCallId.trim() === ''
      ? null
      : await testVoiceCallService.getDraft(
          organisationId,
          testVoiceCallId
        );
  const testVoiceQueuedParameter = query.testVoiceQueued;
  const testVoiceQueued =
    (Array.isArray(testVoiceQueuedParameter)
      ? testVoiceQueuedParameter[0]
      : testVoiceQueuedParameter) === '1';
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

      {testVoiceQueued ? (
        <div className="success-banner" role="status">
          Test voice call queued. It is labelled TEST and does not change the
          customer&apos;s saved contact details or calling frequency.
        </div>
      ) : null}

      <FreeVoiceFlowPreview />

      <VoiceSettingsForm
        organisationId={organisationId}
        settings={settings}
      />

      <VoiceTestCallPanel
        organisationId={organisationId}
        ready={settings.connectionReady && settings.genericFlowReady}
        idempotencyKey={randomUUID()}
        draft={testVoiceCallDraft}
        prepareAction={prepareVoiceTestCall}
        approveAction={approveVoiceTestCall}
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
