import Link from 'next/link';

import { australianTimeZones } from '../../../../server/australian-time-zones.js';
import { requirePlatformOwnerPage } from '../../../../server/platform-page-authorization.js';
import { createCustomerAction } from './actions.js';

const timeZoneLabels = {
  'Australia/Sydney': 'Sydney (NSW and ACT)',
  'Australia/Melbourne': 'Melbourne (Victoria)',
  'Australia/Hobart': 'Hobart (Tasmania)',
  'Australia/Brisbane': 'Brisbane (Queensland)',
  'Australia/Adelaide': 'Adelaide (South Australia)',
  'Australia/Darwin': 'Darwin (Northern Territory)',
  'Australia/Perth': 'Perth (Western Australia)',
  'Australia/Lord_Howe': 'Lord Howe Island',
  'Australia/Broken_Hill': 'Broken Hill (New South Wales)',
  'Australia/Lindeman': 'Lindeman Island (Queensland)',
  'Australia/Eucla': 'Eucla (Western Australia)'
} as const;

export default async function NewPlatformCustomerPage({
  searchParams
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  await requirePlatformOwnerPage();
  const parameters = await searchParams;
  return (
    <div className="platform-page-stack">
      <header className="platform-page-heading">
        <div>
          <span className="eyebrow">Customer onboarding</span>
          <h1>Create a new AccountPulse customer</h1>
          <p>
            Creates a controlled Solo beta workspace, emails the first
            Administrator and sends them through legal acceptance, Xero
            connection and guided setup.
          </p>
        </div>
        <Link className="button button--quiet" href="/platform-admin">
          Cancel
        </Link>
      </header>

      {parameters.error === 'CREATE_FAILED' ? (
        <div className="callout callout--warning" role="alert">
          <strong>The customer was not created</strong>
          <p>
            Check that the email is not already registered and review the form
            values. No partial customer account has been retained.
          </p>
        </div>
      ) : null}

      <form action={createCustomerAction} className="panel page-stack">
        <section>
          <span className="eyebrow">Business</span>
          <h2>Customer workspace</h2>
          <div className="form-grid">
            <label>
              Business name
              <input name="name" maxLength={160} required />
            </label>
            <label>
              Region and time zone
              <select name="timeZone" defaultValue="Australia/Sydney">
                {australianTimeZones.map((timeZone) => (
                  <option key={timeZone} value={timeZone}>
                    {timeZoneLabels[timeZone]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Base currency
              <select name="baseCurrency" defaultValue="AUD">
                <option value="AUD">AUD</option>
              </select>
            </label>
          </div>
        </section>

        <section>
          <span className="eyebrow">First user</span>
          <h2>Customer Administrator</h2>
          <p>
            Cognito sends a branded temporary-password email. The customer must
            set MFA and accept the current legal documents before application
            access is granted.
          </p>
          <div className="form-grid">
            <label>
              Full name
              <input name="adminDisplayName" maxLength={160} required />
            </label>
            <label>
              Email address
              <input name="adminEmail" type="email" autoComplete="off" required />
            </label>
          </div>
        </section>

        <section>
          <span className="eyebrow">Activation and usage</span>
          <h2>Commercial settings</h2>
          <div className="form-grid">
            <label>
              Included SMS parts
              <input name="includedSmsParts" type="number" min={1} max={1_000_000} defaultValue={2_000} required />
            </label>
            <label>
              Usage warning (%)
              <input name="warningPercent" type="number" min={1} max={100} defaultValue={80} required />
            </label>
          </div>
        </section>

        <section>
          <span className="eyebrow">Audit</span>
          <h2>Creation reason</h2>
          <label>
            Reason
            <textarea name="reason" minLength={3} maxLength={500} defaultValue="Approved AccountPulse beta customer" required />
          </label>
          <label className="legal-consent-option">
            <input name="confirmed" type="checkbox" required />
            <span>
              I confirm this customer requested access and the Administrator
              email is correct.
            </span>
          </label>
        </section>

        <div className="callout">
          <strong>Safe defaults</strong>
          <p>
            The workspace begins in dry-run review mode with customer sending
            disabled until Xero is connected, data is reconciled, setup is
            completed and a paid subscription is activated.
          </p>
        </div>
        <button className="button button--primary" type="submit">
          Create customer and send invitation
        </button>
      </form>
    </div>
  );
}
