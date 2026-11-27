import Link from 'next/link';
import { legalIdentity } from '../../server/legal-content.js';
import { isPublicSignupEnabled } from '../../server/public-signup.js';

export const dynamic = 'force-dynamic';

export default function StartPage() {
  const support = legalIdentity();
  const signupEnabled = isPublicSignupEnabled();
  return (
    <main className="public-page">
      <section className="public-card">
        <span className="eyebrow">AccountPulse Solo</span>
        <h1>Connect Xero and start chasing overdue accounts</h1>
        {signupEnabled ? (
          <p>
            Create your AccountPulse account and connect one Xero organisation.
            Card payment is due during signup and does not include a free trial.
          </p>
        ) : (
          <p>Request access to AccountPulse Solo. If you already have an account or invitation, sign in below.</p>
        )}
        <div className="button-row">
          {signupEnabled ? (
            <Link
              href="/auth/login?mode=signup&returnTo=%2Fonboarding"
              className="button button--primary"
            >
              Create account
            </Link>
          ) : (
            <a href={`mailto:${support.supportEmail}?subject=AccountPulse%20access`} className="button button--primary">
              Request access
            </a>
          )}
          <Link href="/auth/login?returnTo=%2Fonboarding" className="button">
            Sign in
          </Link>
        </div>
        <div className="callout">
          <strong>Sign Up with Xero</strong>
          <p>
            This option is pending Xero approval. AccountPulse connects to Xero
            after you sign in.
          </p>
          <button className="button" disabled>
            Pending Xero approval
          </button>
        </div>
        <p className="muted-copy">
          <Link href="/legal/terms">Terms</Link> ·{' '}
          <Link href="/legal/privacy">Privacy</Link> ·{' '}
          <Link href="/legal/acceptable-use">Acceptable use</Link>
        </p>
      </section>
    </main>
  );
}
