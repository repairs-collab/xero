import { headers } from 'next/headers';

import {
  getXeroOAuthService,
  requireWebIdentitySession
} from '../../../server/runtime.js';
import { selectSoloXeroTenant } from './actions.js';

export default async function SelectSoloXeroPage({
  searchParams
}: {
  searchParams: Promise<{ pending?: string }>;
}) {
  const pending = (await searchParams).pending;
  if (!pending) throw new Error('Pending Xero connection is required');
  const session = await requireWebIdentitySession(
    new Request('http://localhost/', { headers: await headers() })
  );
  const selection = await getXeroOAuthService().getSoloTenantSelection(
    session,
    pending
  );

  return (
    <main className="public-page">
      <section className="public-card">
        <span className="eyebrow">Step 2 of 2</span>
        <h1>Choose one Xero organisation</h1>
        <p>
          The Solo edition connects one organisation. Another organisation can
          be added later through an Enterprise plan.
        </p>
        <form action={selectSoloXeroTenant} className="page-stack">
          <input
            type="hidden"
            name="pendingAuthorisationId"
            value={pending}
          />
          {selection.candidates.map((candidate, index) => (
            <label className="sequence-card" key={candidate.connectionId}>
              <input
                type="radio"
                name="selection"
                value={`${candidate.connectionId}|${candidate.tenantId}`}
                defaultChecked={index === 0}
                required
              />
              <span>{candidate.tenantName}</span>
            </label>
          ))}
          <button className="button button--primary">
            Create Solo workspace
          </button>
        </form>
      </section>
    </main>
  );
}
