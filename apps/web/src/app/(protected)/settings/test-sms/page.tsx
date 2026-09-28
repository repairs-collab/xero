import { randomUUID } from 'node:crypto';

import { CheckCircleIcon } from '@heroicons/react/24/outline';
import { eq } from 'drizzle-orm';
import { headers } from 'next/headers';
import Link from 'next/link';

import { authorise } from '@bc5000/auth';
import { organisations } from '@bc5000/db/web';

import { TestSmsForm } from '../../../../components/test-sms-form.js';
import { getDatabaseClient, requireWebSession } from '../../../../server/runtime.js';

type SearchParameters = Promise<
  Record<string, string | string[] | undefined>
>;

export default async function TestSmsPage({
  searchParams
}: {
  searchParams: SearchParameters;
}) {
  const session = await requireWebSession(
    new Request('http://localhost/', { headers: await headers() })
  );
  const organisationId = session.memberships[0]?.organisationId;
  if (organisationId === undefined) {
    throw new Error('No active organisation membership');
  }
  authorise(session, 'message.test-sms', organisationId);
  const [organisation] = await getDatabaseClient()
    .db.select({ sendMode: organisations.sendMode })
    .from(organisations)
    .where(eq(organisations.id, organisationId))
    .limit(1);
  if (organisation === undefined) throw new Error('Organisation not found');
  const parameters = await searchParams;
  const queued = parameters.queued === 'yes';

  return (
    <div className="page-stack test-sms-page">
      <Link className="back-link" href="/settings">
        ← Back to settings
      </Link>
      <header className="page-heading">
        <span className="eyebrow">Administrator tool</span>
        <h1>Test SMS</h1>
        <p>
          Check a number and message through the same safe delivery controls as
          AccountPulse reminders.
        </p>
      </header>

      {queued && (
        <div className="test-sms-result" role="status">
          <CheckCircleIcon aria-hidden="true" />
          <div>
            <strong>Test SMS queued</strong>
            <p>
              Open Outbox to see whether it was a dry run, accepted by Sinch, or
              delivered.
            </p>
          </div>
          <Link className="button button--primary" href="/outbox?source=TEST_SMS">
            View in Outbox
          </Link>
        </div>
      )}

      <section className="panel test-sms-panel">
        <div className="panel__heading">
          <div>
            <span className="eyebrow">Safe delivery test</span>
            <h2>Compose a test message</h2>
          </div>
          <span className="status-chip">
            {organisation.sendMode === 'live' ? 'Live controls' : 'Dry run'}
          </span>
        </div>
        <TestSmsForm
          organisationId={organisationId}
          requestId={randomUUID()}
          sendMode={organisation.sendMode}
        />
      </section>
    </div>
  );
}
