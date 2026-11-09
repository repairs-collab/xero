export default function AccountRecoveryPage() {
  return (
    <main
      id="main-content"
      style={{
        minHeight: '100vh',
        display: 'grid',
        placeItems: 'center',
        padding: 24
      }}
    >
      <section className="panel" style={{ maxWidth: 560, padding: 36 }}>
        <span className="eyebrow">Account security</span>
        <h1>This email is already linked</h1>
        <p style={{ color: 'var(--muted)', lineHeight: 1.65 }}>
          We did not merge the new sign-in with the existing AccountPulse
          account. Sign in with the original account, or contact support so we
          can verify ownership safely.
        </p>
        <div style={{ display: 'flex', gap: 10, marginTop: 24 }}>
          <a className="button button--primary" href="/auth/login">
            Sign in again
          </a>
          <a className="button" href="mailto:repairs@motts.com.au">
            Contact support
          </a>
        </div>
      </section>
    </main>
  );
}
