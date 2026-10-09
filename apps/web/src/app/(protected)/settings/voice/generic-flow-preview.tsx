'use client';

import { useRef, useState } from 'react';
import {
  RetellClient,
  type WebCallOptions,
  type WebCallSession
} from 'retell-client-js-sdk';

import { recordGenericFlowTest } from './actions.js';

export interface GenericFlowPreviewConfigurationInput {
  agentId: string;
  agentVersion: number;
  previewSessionId: string;
  recaptchaToken?: string;
}

export const createGenericFlowPreviewConfiguration = (
  input: GenericFlowPreviewConfigurationInput
): Omit<WebCallOptions, 'hooks'> => ({
  agent_id: input.agentId,
  agent_version: input.agentVersion,
  transcript: false,
  ...(input.recaptchaToken === undefined
    ? {}
    : { recaptchaToken: input.recaptchaToken }),
  metadata: {
    accountpulse_preview_session_id: input.previewSessionId
  },
  retell_llm_dynamic_variables: {
    accountpulse_call_id: `preview-${input.previewSessionId}`,
    preview_mode: 'true',
    disable_outbound_call: 'true',
    disable_transfer: 'true',
    invoice_details_json: JSON.stringify([
      { invoiceNumber: 'DEMO-1001', amountDue: '120.50' },
      { invoiceNumber: 'DEMO-1002', amountDue: '80.05' }
    ]),
    combined_amount: '200.55',
    currency: 'AUD',
    callback_number: '+61200000000',
    fallback_office_number: '+61200000000'
  }
});

declare global {
  interface Window {
    grecaptcha?: {
      ready(callback: () => void): void;
      execute(siteKey: string, options: { action: string }): Promise<string>;
    };
  }
}

const recaptchaToken = async (
  siteKey: string | null
): Promise<string | undefined> => {
  if (siteKey === null) return undefined;
  const recaptcha = window.grecaptcha;
  if (recaptcha === undefined) throw new Error('reCAPTCHA is not ready');
  await new Promise<void>((resolve) => recaptcha.ready(resolve));
  return recaptcha.execute(siteKey, { action: 'voice_setup_preview' });
};

export interface GenericFlowPreviewProps {
  organisationId: string;
  previewPublicKey: string;
  agentId: string;
  agentVersion: number;
  previewSessionId: string;
  previewSessionToken: string;
  recaptchaSiteKey?: string | null;
}

export function GenericFlowPreview({
  organisationId,
  previewPublicKey,
  agentId,
  agentVersion,
  previewSessionId,
  previewSessionToken,
  recaptchaSiteKey = null
}: GenericFlowPreviewProps) {
  const session = useRef<WebCallSession | null>(null);
  const [status, setStatus] = useState('Ready');
  const [completed, setCompleted] = useState(false);
  const [busy, setBusy] = useState(false);

  const start = async () => {
    setBusy(true);
    setCompleted(false);
    setStatus('Connecting to fictional preview');
    try {
      const token = await recaptchaToken(recaptchaSiteKey);
      const client = new RetellClient({ key: previewPublicKey });
      const call = client.createWebCall({
        ...createGenericFlowPreviewConfiguration({
          agentId,
          agentVersion,
          previewSessionId,
          ...(token === undefined ? {} : { recaptchaToken: token })
        }),
        hooks: {
          onStatus: (nextStatus) => setStatus(String(nextStatus)),
          onEnd: () => {
            setStatus('Preview ended');
            setCompleted(true);
            setBusy(false);
            session.current = null;
          },
          onError: () => {
            setStatus('Preview could not start');
            setBusy(false);
          }
        }
      });
      session.current = call;
      await call.ready;
      setStatus('Fictional preview in progress');
    } catch {
      setStatus('Preview could not start');
      setBusy(false);
    }
  };

  const stop = async () => {
    await session.current?.end();
    session.current = null;
    setStatus('Preview ended');
    setCompleted(true);
    setBusy(false);
  };

  return (
    <section className="panel voice-preview-panel">
      <div className="panel__heading">
        <div>
          <span className="eyebrow">Fictional setup preview</span>
          <h2>Try the locked call flow in this browser</h2>
        </div>
        <span className="status-chip">{status}</span>
      </div>
      <p>
        No customer will be called. The example uses invoices DEMO-1001 and
        DEMO-1002, and transfer is disabled.
      </p>
      <p>No transcript or recording is kept by AccountPulse.</p>
      <div className="button-row">
        <button
          className="button button--primary"
          type="button"
          onClick={() => void start()}
          disabled={busy}
        >
          Start fictional preview
        </button>
        <button
          className="button"
          type="button"
          onClick={() => void stop()}
          disabled={!busy}
        >
          End preview
        </button>
      </div>
      <form action={recordGenericFlowTest} className="settings-form">
        <input type="hidden" name="organisationId" value={organisationId} />
        <input
          type="hidden"
          name="previewSessionToken"
          value={previewSessionToken}
        />
        <button className="button" disabled={!completed}>
          Confirm the fictional flow worked
        </button>
      </form>
    </section>
  );
}
