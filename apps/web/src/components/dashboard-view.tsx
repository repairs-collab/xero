import Link from 'next/link';

import { KpiCard } from './kpi-card.js';

export interface DashboardModel {
  overdueTotal: string;
  overdueCount: number;
  awaitingApproval: number;
  pausedCustomers: number;
  openEscalations: number;
  paidAfterReminders: string;
  lastXeroSync: string;
  xeroHealthy: boolean;
  sinchHealthy: boolean;
}

const StatusDot = ({ healthy }: { healthy: boolean }) => (
  <span className={`status-dot ${healthy ? 'status-dot--ok' : 'status-dot--bad'}`} />
);

export function DashboardView({ model }: { model: DashboardModel }) {
  return (
    <div className="page-stack">
      <header className="page-heading page-heading--split">
        <div>
          <span className="eyebrow">Today&apos;s collection workspace</span>
          <h1>Overview</h1>
          <p>Keep receivables moving without losing the human touch.</p>
        </div>
        <div className="provider-health" aria-label="Provider health">
          <span><StatusDot healthy={model.xeroHealthy} />Xero {model.xeroHealthy ? 'connected' : 'needs attention'}</span>
          <span><StatusDot healthy={model.sinchHealthy} />Sinch {model.sinchHealthy ? 'connected' : 'needs attention'}</span>
        </div>
      </header>

      <section className="kpi-grid" aria-label="Collections summary">
        <KpiCard eyebrow="Total overdue" value={model.overdueTotal} detail={`${model.overdueCount} open invoices`} accent="blue" icon="$" />
        <KpiCard eyebrow="Awaiting approval" value={String(model.awaitingApproval)} detail="Reminders ready to review" accent="amber" icon="✓" />
        <KpiCard eyebrow="Paused customers" value={String(model.pausedCustomers)} detail="Replies, disputes and promises" icon="Ⅱ" />
        <KpiCard eyebrow="Open escalations" value={String(model.openEscalations)} detail="Need a person to follow up" accent="amber" icon="!" />
      </section>

      <section className="overview-grid">
        <article className="panel action-panel">
          <div className="panel__heading">
            <div>
              <span className="eyebrow">Next best actions</span>
              <h2>Keep today on track</h2>
            </div>
            <Link href="/approvals" className="text-link">View all approvals →</Link>
          </div>
          <div className="action-list">
            <Link className="action-row" href="/approvals">
              <span className="action-row__badge action-row__badge--amber">{model.awaitingApproval}</span>
              <span><strong>Review reminders</strong><small>Check exact message previews before they leave</small></span>
              <span aria-hidden="true">›</span>
            </Link>
            <Link className="action-row" href="/escalations">
              <span className="action-row__badge">{model.openEscalations}</span>
              <span><strong>Handle escalations</strong><small>Call or personally follow up 30-day accounts</small></span>
              <span aria-hidden="true">›</span>
            </Link>
            <Link className="action-row" href="/inbox">
              <span className="action-row__badge">{model.pausedCustomers}</span>
              <span><strong>Resolve paused conversations</strong><small>Reply, record an arrangement, or resume chasing</small></span>
              <span aria-hidden="true">›</span>
            </Link>
          </div>
        </article>

        <aside className="panel performance-panel">
          <span className="eyebrow">Collection signal</span>
          <h2>Paid after reminders</h2>
          <strong className="performance-value">{model.paidAfterReminders}</strong>
          <p>Invoices paid after at least one reminder was sent. This is correlation, not claimed attribution.</p>
          <div className="sync-note"><span aria-hidden="true">↻</span> Last Xero sync <strong>{model.lastXeroSync}</strong></div>
        </aside>
      </section>
    </div>
  );
}
