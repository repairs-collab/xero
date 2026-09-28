'use client';

import { useState } from 'react';

import { recordCallLinkOpened } from '../app/(protected)/escalations/actions.js';

export function CallClientButton({
  organisationId,
  taskId,
  available,
  disabledReason
}: {
  organisationId: string;
  taskId: string;
  available: boolean;
  disabledReason?: string;
}) {
  const [launching, setLaunching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const launchCall = async () => {
    setLaunching(true);
    setError(null);
    try {
      const formData = new FormData();
      formData.set('organisationId', organisationId);
      formData.set('taskId', taskId);
      const result = await recordCallLinkOpened(formData);
      window.location.assign(result.href);
    } catch {
      setError('The call could not be opened. Check the client phone number and try again.');
      setLaunching(false);
    }
  };

  return (
    <span className="call-client-control">
      <button
        className="button"
        type="button"
        disabled={!available || launching}
        title={!available ? disabledReason : undefined}
        onClick={() => {
          void launchCall();
        }}
      >
        {launching ? 'Opening phone…' : 'Call client'}
      </button>
      {error !== null && <small role="alert">{error}</small>}
    </span>
  );
}
