export function AccountSuspendedBanner() {
  return (
    <section className="account-suspended-banner" role="alert">
      <strong>Account suspended</strong>
      <span>
        AccountPulse is read-only. Automated and manual sending are paused.
      </span>
      <a href="/settings/billing">Review billing</a>
    </section>
  );
}
