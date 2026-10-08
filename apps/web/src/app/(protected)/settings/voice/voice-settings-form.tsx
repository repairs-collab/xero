import { fixedVoiceCallCopy } from '@bc5000/domain';

import {
  saveVoiceSettings,
  setVoiceEnabled,
  testVoiceConnection
} from './actions.js';
import type { VoiceSettingsView } from './voice-settings.js';

export interface VoiceSettingsFormProps {
  organisationId: string;
  settings: VoiceSettingsView;
}

const readinessLabel = (ready: boolean, readyText: string, waitingText: string) =>
  ready ? readyText : waitingText;

export function VoiceSettingsForm({
  organisationId,
  settings
}: VoiceSettingsFormProps) {
  return (
    <div className="page-stack">
      <section className="panel">
        <div className="panel__heading">
          <div>
            <span className="eyebrow">Manual calling control</span>
            <h2>
              Manual voice calls are {settings.enabled ? 'on' : 'off'}
            </h2>
          </div>
          <span className="status-chip">
            {settings.enabled ? 'Enabled' : 'Disabled'}
          </span>
        </div>
        <p>
          Enabling this allows manual, one-at-a-time voice calls only. Customer
          Live SMS and email remain unchanged.
        </p>
        <div className="readiness-grid">
          <article>
            <strong>Provider readiness</strong>
            <p>
              {readinessLabel(
                settings.connectionReady,
                'Connection ready',
                'Connection test required'
              )}
            </p>
          </article>
          <article>
            <strong>Generic flow preview</strong>
            <p>
              {readinessLabel(
                settings.genericFlowReady,
                'Generic flow tested',
                'Generic flow test required'
              )}
            </p>
          </article>
        </div>
        <form action={setVoiceEnabled} className="settings-form">
          <input type="hidden" name="organisationId" value={organisationId} />
          <input
            type="hidden"
            name="enabled"
            value={settings.enabled ? 'false' : 'true'}
          />
          {!settings.enabled ? (
            <label>
              Type ENABLE VOICE CALLS to enable
              <input name="confirmation" autoComplete="off" required />
            </label>
          ) : null}
          <button className="button button--primary">
            {settings.enabled ? 'Disable manual voice calls' : 'Enable manual voice calls'}
          </button>
        </form>
      </section>

      <section className="panel">
        <div className="panel__heading">
          <div>
            <span className="eyebrow">Provider configuration</span>
            <h2>Retell voice settings</h2>
          </div>
          <span className="status-chip">
            {settings.configured ? 'Configured' : 'Not configured'}
          </span>
        </div>
        <form action={saveVoiceSettings} className="settings-form">
          <input type="hidden" name="organisationId" value={organisationId} />
          <input type="hidden" name="provider" value="RETELL" />
          <label>
            Managed secret reference
            <input
              name="secretReference"
              placeholder={
                settings.secretReferenceLabel ?? 'env:RETELL_API_KEY'
              }
            />
            <small>
              {settings.secretReferenceLabel
                ? `Current reference: ${settings.secretReferenceLabel}. Leave blank to keep it.`
                : 'Enter a managed-secret reference, never the key itself.'}
            </small>
          </label>
          <label>
            Domain-restricted public preview key
            <input
              name="previewPublicKey"
              defaultValue={settings.previewPublicKey ?? ''}
              required
            />
          </label>
          <label>
            Agent ID
            <input name="agentId" defaultValue={settings.agentId ?? ''} required />
          </label>
          <label>
            Pinned agent version
            <input
              name="agentVersion"
              type="number"
              min="0"
              step="1"
              defaultValue={settings.agentVersion ?? 0}
              required
            />
          </label>
          <label>
            Voice ID
            <input name="voiceId" defaultValue={settings.voiceId ?? ''} required />
          </label>
          <label>
            Voice label
            <input
              name="voiceLabel"
              defaultValue={settings.voiceLabel ?? ''}
              required
            />
          </label>
          <label>
            Outbound number
            <input
              name="outboundNumber"
              defaultValue={settings.outboundNumber ?? ''}
              placeholder="+61255501234"
              required
            />
          </label>
          <label>
            VoIPline SIP transfer target (optional)
            <input
              name="transferSipUri"
              defaultValue={settings.transferSipUri ?? ''}
              placeholder="sip:accounts@example.com"
            />
          </label>
          <label>
            Office fallback number
            <input
              name="fallbackOfficeNumber"
              defaultValue={settings.fallbackOfficeNumber ?? ''}
              placeholder="+61255504321"
              required
            />
          </label>
          <label>
            Office destination label
            <input
              name="officeDestinationLabel"
              defaultValue={settings.officeDestinationLabel ?? ''}
              required
            />
          </label>
          <label>
            Timezone
            <input name="timezone" defaultValue={settings.timezone} required />
          </label>
          <label>
            Calling window starts
            <input
              name="weekdayStartLocal"
              type="time"
              defaultValue={settings.weekdayStartLocal}
              required
            />
          </label>
          <label>
            Calling window ends
            <input
              name="weekdayEndLocal"
              type="time"
              defaultValue={settings.weekdayEndLocal}
              required
            />
          </label>
          <button className="button">Save and disable until retested</button>
        </form>
        <form action={testVoiceConnection}>
          <input type="hidden" name="organisationId" value={organisationId} />
          <button className="button button--primary">Test provider setup</button>
        </form>
      </section>

      <section className="panel">
        <span className="eyebrow">Locked generic flow</span>
        <h2>Customer-safe wording</h2>
        <h3>Opening</h3>
        <p>{fixedVoiceCallCopy.opening}</p>
        <h3>Voicemail</h3>
        <p>{fixedVoiceCallCopy.voicemail}</p>
        <small>
          Flow version {settings.callFlowVersion}. Wording cannot be edited on
          this page.
        </small>
      </section>
    </div>
  );
}
