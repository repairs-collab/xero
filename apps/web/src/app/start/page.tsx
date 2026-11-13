import Link from 'next/link';
import { legalIdentity } from '../../server/legal-content.js';

export default function StartPage() {
  const support = legalIdentity();
  return (
    <main className="public-page">
      <section className="public-card">
        <span className="eyebrow">AccountPulse Solo</span>
        <h1>Connect Xero and start chasing overdue accounts</h1>
        <p>
          Invited beta customers can connect one Xero organisation in
          controlled review mode. For paid commercial access, card payment is
          due during signup and does not include a free trial.
        </p>
        <div className="button-row">
          <Link href="/auth/login?returnTo=%2Fonboarding" className="button button--primary">
            Sign in
          </Link>
          <a href={`mailto:${support.supportEmail}?subject=AccountPulse%20beta%20access`} className="button">
            Request beta access
          </a>
        </div>
        <div className="callout">
          <strong>Sign Up with Xero</strong>
          <p>
            This entry is held behind the release gate until Xero confirms the
            approved identity hand-off. The secure account-first connection is
            available above.
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
