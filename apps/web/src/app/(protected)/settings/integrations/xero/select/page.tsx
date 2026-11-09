import { headers } from 'next/headers';

import {
  getXeroOAuthService,
  requireWebSession
} from '../../../../../../server/runtime.js';
import { selectXeroTenant } from './actions.js';

export default async function SelectXeroTenantPage({
  searchParams
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const parameters = await searchParams;
  const organisationId = parameters.organisationId;
  const pendingAuthorisationId = parameters.pending;
  if (
    typeof organisationId !== 'string' ||
    typeof pendingAuthorisationId !== 'string'
  ) {
    throw new Error('XERO_PENDING_AUTHORISATION_INVALID');
  }
  const session = await requireWebSession(
    new Request('http://localhost/', { headers: await headers() })
  );
  const selection = await getXeroOAuthService().getTenantSelection(session, {
    organisationId,
    pendingAuthorisationId
  });

  return (
    <div className="page-stack">
      <a className="back-link" href="/settings/integrations">
        ← Integrations
      </a>
      <header className="page-heading">
        <span className="eyebrow">Xero connection</span>
        <h1>Choose your Xero organisation</h1>
        <p>
          This AccountPulse Solo subscription can connect to one Xero
          organisation. Choose the organisation for your current Solo account.
        </p>
      </header>
      <section className="panel page-stack">
        {selection.candidates.map((candidate) => (
          <form action={selectXeroTenant} key={candidate.connectionId}>
            <input type="hidden" name="organisationId" value={organisationId} />
            <input
              type="hidden"
              name="pendingAuthorisationId"
              value={pendingAuthorisationId}
            />
            <input
              type="hidden"
              name="connectionId"
              value={candidate.connectionId}
            />
            <input type="hidden" name="tenantId" value={candidate.tenantId} />
            <button className="button button--primary" type="submit">
              Connect {candidate.tenantName}
            </button>
          </form>
        ))}
      </section>
      <aside className="panel">
        <h2>Need more than one Xero organisation?</h2>
        <p>
          Your existing Solo organisation stays unchanged. Multi-organisation
          access is planned for AccountPulse Enterprise; join the Enterprise
          waitlist before adding another organisation.
        </p>
      </aside>
    </div>
  );
}
