import { ChevronRightIcon } from '@heroicons/react/24/outline';
import { headers } from 'next/headers';
import Link from 'next/link';

import { requireWebSession } from '../../../server/runtime.js';
import { settingsCardsForRole } from './settings-cards.js';

export default async function SettingsPage() {
  const session = await requireWebSession(
    new Request('http://localhost/', { headers: await headers() })
  );
  const role = session.memberships[0]?.role;
  if (role === undefined) throw new Error('No active organisation membership');

  return (
    <div className="page-stack">
      <header className="page-heading">
        <span className="eyebrow">Administration</span>
        <h1>Admin Settings</h1>
        <p>Manage users, providers, and the safeguards around live sending.</p>
      </header>
      <div className="settings-home">
        {settingsCardsForRole(role).map((card) => (
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
