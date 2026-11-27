import { ChevronRightIcon } from '@heroicons/react/24/outline';
import { headers } from 'next/headers';
import Link from 'next/link';

import { getDatabaseClient, requireWebSession } from '../../../server/runtime.js';
import { settingsCardsForRole } from './settings-cards.js';
import { loadSettingsWorkspaceEdition } from './settings-workspace.js';

export default async function SettingsPage() {
  const session = await requireWebSession(
    new Request('http://localhost/', { headers: await headers() })
  );
  const membership = session.memberships[0];
  if (membership === undefined) throw new Error('No active organisation membership');
  const edition = await loadSettingsWorkspaceEdition(
    getDatabaseClient().db,
    membership.organisationId
  );

  return (
    <div className="page-stack">
      <header className="page-heading">
        <span className="eyebrow">Administration</span>
        <h1>Admin Settings</h1>
        <p>
          {edition === 'SOLO'
            ? 'Manage your Xero connection, reminders and account.'
            : 'Manage users, Xero, and the safeguards around live sending.'}
        </p>
      </header>
      <div className="settings-home">
        {settingsCardsForRole(membership.role, edition).map((card) => (
          <Link href={card.href} className="sequence-card" key={card.href}>
            <div>
              <span className="eyebrow">{card.eyebrow}</span>
              <h2>{card.title}</h2>
              <p>{card.description}</p>
            </div>
            <ChevronRightIcon
              className="sequence-card__arrow"
              aria-hidden="true"
            />
          </Link>
        ))}
      </div>
    </div>
  );
}
