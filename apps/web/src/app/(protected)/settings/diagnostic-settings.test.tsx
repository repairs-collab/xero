import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getDatabaseClient: vi.fn(),
  getJobQueue: vi.fn(),
  getVoiceProviderTester: vi.fn(),
  requireWebSession: vi.fn(),
  requireWebAcceptedSession: vi.fn(),
  settingsGet: vi.fn(),
  redirect: vi.fn((path: string): never => { throw new Error(`Redirect to ${path}`); })
}));

vi.mock('next/headers', () => ({ headers: () => Promise.resolve(new Headers()) }));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));
vi.mock('../../../server/runtime.js', () => ({
  getDatabaseClient: mocks.getDatabaseClient,
  getVoiceProviderTester: mocks.getVoiceProviderTester,
  issueVoicePreviewSession: vi.fn(),
  requireWebAcceptedSession: mocks.requireWebAcceptedSession,
  requireWebSession: mocks.requireWebSession,
  verifyVoicePreviewSession: vi.fn()
}));
vi.mock('../../../server/job-runtime.js', () => ({ getJobQueue: mocks.getJobQueue }));
vi.mock('./voice/voice-settings.js', () => ({
  createVoiceSettingsService: () => ({ get: mocks.settingsGet })
}));
vi.mock('./voice/voice-settings-form.js', () => ({
  VoiceSettingsForm: () => <div>Provider and voice configuration</div>
}));
vi.mock('./voice/free-voice-flow-preview.js', () => ({
  FreeVoiceFlowPreview: () => <div>Fictional voice flow preview</div>
}));
vi.mock('./voice/voice-test-call-panel.js', () => ({
  VoiceTestCallPanel: () => <div>Staff test call</div>
}));

import SettingsPage from './page.js';
import TestSmsPage from './test-sms/page.js';
import VoiceSettingsPage from './voice/page.js';
import { queueTestSms } from './test-sms/actions.js';
import { prepareVoiceTestCall, testVoiceConnection } from './voice/actions.js';

const organisationId = '00000000-0000-4000-8000-000000000001';
const fixture = {
  userId: 'workspace-admin',
  displayName: 'Workspace Admin',
  memberships: [{ organisationId, active: true, role: 'ADMIN', organisationStatus: 'ACTIVE' }]
};

function setWorkspaceEdition(edition: 'SOLO' | 'INTERNAL_LEGACY') {
  mocks.getDatabaseClient.mockReturnValue({
    db: {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve([{ edition, sendMode: 'live' }])
          })
        })
      })
    }
  });
}

describe('legacy diagnostic settings boundaries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireWebSession.mockResolvedValue(fixture);
    mocks.requireWebAcceptedSession.mockResolvedValue(fixture);
    mocks.getJobQueue.mockResolvedValue({});
    mocks.settingsGet.mockResolvedValue({
      configured: false,
      connectionReady: false,
      gatewayReady: false,
      genericFlowReady: false
    });
    setWorkspaceEdition('SOLO');
  });

  it('shows customer settings without links to diagnostics for Solo', async () => {
    const html = renderToStaticMarkup(await SettingsPage());
    expect(html).toContain('href="/settings/integrations"');
    expect(html).toContain('href="/settings/billing"');
    expect(html).toContain('href="/settings/sending"');
    expect(html).toContain('Customer sending');
    expect(html).not.toContain('href="/settings/test-sms"');
    expect(html).not.toContain('href="/settings/voice"');
  });

  it('redirects bookmarked diagnostic pages before loading any provider tools for Solo', async () => {
    await expect(TestSmsPage({ searchParams: Promise.resolve({ queued: 'yes' }) }))
      .rejects.toThrow('Redirect to /settings');
    await expect(VoiceSettingsPage({ searchParams: Promise.resolve({ testVoiceCall: 'old-draft' }) }))
      .rejects.toThrow('Redirect to /settings');
    expect(mocks.getVoiceProviderTester).not.toHaveBeenCalled();
    expect(mocks.getJobQueue).not.toHaveBeenCalled();
  });

  it('rejects stale diagnostic form actions for Solo before a gateway or queue is opened', async () => {
    const form = new FormData();
    form.set('organisationId', organisationId);
    await expect(queueTestSms(form)).rejects.toThrow('FORBIDDEN');
    await expect(prepareVoiceTestCall(form)).rejects.toThrow('FORBIDDEN');
    await expect(testVoiceConnection(form)).rejects.toThrow('FORBIDDEN');
    expect(mocks.getVoiceProviderTester).not.toHaveBeenCalled();
    expect(mocks.getJobQueue).not.toHaveBeenCalled();
  });

  it('rejects a workspace selected in form data without a matching membership', async () => {
    const form = new FormData();
    form.set('organisationId', '00000000-0000-4000-8000-000000000002');
    await expect(queueTestSms(form)).rejects.toThrow('FORBIDDEN');
    await expect(prepareVoiceTestCall(form)).rejects.toThrow('FORBIDDEN');
    expect(mocks.getDatabaseClient).not.toHaveBeenCalled();
    expect(mocks.getJobQueue).not.toHaveBeenCalled();
  });

  it('keeps both diagnostics accessible to a legacy Administrator', async () => {
    setWorkspaceEdition('INTERNAL_LEGACY');
    const settings = renderToStaticMarkup(await SettingsPage());
    const sms = renderToStaticMarkup(await TestSmsPage({ searchParams: Promise.resolve({}) }));
    const voice = renderToStaticMarkup(await VoiceSettingsPage({ searchParams: Promise.resolve({}) }));
    expect(settings).toContain('href="/settings/test-sms"');
    expect(settings).toContain('href="/settings/voice"');
    expect(settings).toContain('Sending controls');
    expect(sms).toContain('Queue test SMS');
    expect(voice).toContain('Provider and voice configuration');
    expect(voice).toContain('Staff test call');
    expect(mocks.redirect).not.toHaveBeenCalled();
  });
});
