import Link from 'next/link';

export default function PlatformAdminNotFound() {
  return (
    <main className="auth-page">
      <section className="auth-card">
        <h1>Page not found</h1>
        <p>This private AccountPulse page is unavailable.</p>
        <Link href="/">Return to AccountPulse</Link>
      </section>
    </main>
  );
}
