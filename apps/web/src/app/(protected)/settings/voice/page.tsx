import { randomUUID } from 'node:crypto';

import { headers } from 'next/headers';
import Link from 'next/link';

import { PostgresVoiceCallRepository } from '@bc5000/db/web';

import { getJobQueue } from '../../../../server/job-runtime.js';
import { createServerClock } from '../../../../server/clock.js';
import {
  getDatabaseClient,
  getVoiceProviderTester,
  issueVoicePreviewSession,
  requireWebSession,
  verifyVoicePreviewSession
} from '../../../../server/runtime.js';
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
  const clock = createServerClock();
  const settingsService = createVoiceSettingsService({
    database,
    session,
    tester: getVoiceProviderTester(),
    previewSessions: { verify: verifyVoicePreviewSession },
    clock
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
    clock,
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
    settings.voipcloudUserNumber !== null &&
    settings.gatewayFlowVersion !== null &&
    settings.ttsVoiceId !== null
      ? issueVoicePreviewSession({
          organisationId,
          userId: session.userId,
          callFlowHash: settings.callFlowHash,
          callFlowVersion: settings.callFlowVersion,
          configurationVersion: settings.configurationVersion,
          voipcloudUserNumber: settings.voipcloudUserNumber,
          gatewayFlowVersion: settings.gatewayFlowVersion,
          ttsVoiceId: settings.ttsVoiceId
        })
      : null;

  return (
    <div className="page-stack voice-settings-page">
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

      <FreeVoiceFlowPreview
        organisationId={organisationId}
        {...(previewSession === null
          ? {}
          : { previewSessionToken: previewSession.token })}
      />

      <VoiceSettingsForm
        organisationId={organisationId}
        settings={settings}
      />

      <VoiceTestCallPanel
        organisationId={organisationId}
        ready={
          settings.connectionReady &&
          settings.gatewayReady &&
          settings.genericFlowReady
        }
        idempotencyKey={randomUUID()}
        draft={testVoiceCallDraft}
        prepareAction={prepareVoiceTestCall}
        approveAction={approveVoiceTestCall}
      />
    </div>
  );
}
