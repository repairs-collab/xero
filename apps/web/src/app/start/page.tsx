import Link from 'next/link';

export default function StartPage() {
  return (
    <main className="public-page">
      <section className="public-card">
        <span className="eyebrow">AccountPulse Solo</span>
        <h1>Connect Xero and start chasing overdue accounts</h1>
        <p>
          Create your secure AccountPulse account, connect one Xero
          organisation, and review your reminders during a 14-day free trial.
          No card is required for the trial.
        </p>
        <div className="button-row">
          <Link
            href="/auth/login?mode=signup&returnTo=%2Fonboarding"
            className="button button--primary"
          >
            Start free trial
          </Link>
          <Link href="/auth/login?returnTo=%2F" className="button">
            Sign in
          </Link>
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
          Support, security and privacy enquiries: repairs@motts.com.au
        </p>
      </section>
    </main>
  );
}
