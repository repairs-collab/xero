import {
  ArrowPathIcon,
  ArrowRightIcon,
  BanknotesIcon,
  CheckCircleIcon,
  ClockIcon,
  ExclamationTriangleIcon,
  PauseIcon
} from '@heroicons/react/24/outline';
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

      <section className="overview-ledger" aria-label="Collections overview">
        <aside className="summary-panel">
          <div className="section-heading">
            <span className="eyebrow">Collection snapshot</span>
            <h2>Current position</h2>
          </div>
          <div className="kpi-grid" aria-label="Collections summary">
            <KpiCard eyebrow="Total overdue" value={model.overdueTotal} detail={`${model.overdueCount} open invoices`} accent="blue" icon={<BanknotesIcon />} />
            <KpiCard eyebrow="Awaiting approval" value={String(model.awaitingApproval)} detail="Reminders ready to review" accent="amber" icon={<ClockIcon />} />
            <KpiCard eyebrow="Paused customers" value={String(model.pausedCustomers)} detail="Replies, disputes and promises" icon={<PauseIcon />} />
            <KpiCard eyebrow="Open escalations" value={String(model.openEscalations)} detail="Need a person to follow up" accent="amber" icon={<ExclamationTriangleIcon />} />
          </div>
        </aside>

        <article className="panel action-panel">
          <div className="panel__heading">
            <div>
              <span className="eyebrow">Today&apos;s action ledger</span>
              <h2>Keep today moving</h2>
              <p>Start with the highest-impact collection work.</p>
            </div>
            <Link href="/approvals" className="text-link">View all approvals</Link>
          </div>
          <div className="action-list">
            <Link className="action-row action-row--primary" href="/approvals">
              <span className="action-row__step">1</span>
              <span><strong>Review reminders</strong><small>Check exact message previews before they leave</small></span>
              <span className="action-row__count"><strong>{model.awaitingApproval}</strong><small>ready</small></span>
              <ArrowRightIcon aria-hidden="true" />
            </Link>
            <Link className="action-row" href="/escalations">
              <span className="action-row__step">2</span>
              <span><strong>Handle escalations</strong><small>Call or personally follow up 30-day accounts</small></span>
              <span className="action-row__count"><strong>{model.openEscalations}</strong><small>open</small></span>
              <ArrowRightIcon aria-hidden="true" />
            </Link>
            <Link className="action-row" href="/inbox">
              <span className="action-row__step">3</span>
              <span><strong>Resolve paused conversations</strong><small>Reply, record an arrangement, or resume chasing</small></span>
              <span className="action-row__count"><strong>{model.pausedCustomers}</strong><small>paused</small></span>
              <ArrowRightIcon aria-hidden="true" />
            </Link>
          </div>
        </article>

        <aside className="signal-column">
          <article className="panel performance-panel">
            <span className="eyebrow">Collection signal</span>
            <div className="performance-heading">
              <CheckCircleIcon aria-hidden="true" />
              <div><h2>Paid after reminders</h2><strong className="performance-value">{model.paidAfterReminders}</strong></div>
            </div>
            <div className="signal-rule" aria-hidden="true"><span /><span /><span /></div>
            <p>Invoices paid after at least one reminder was sent. This is correlation, not claimed attribution.</p>
          </article>
          <article className="panel sync-panel">
            <span className="eyebrow">Latest sync</span>
            <div className="sync-note"><ArrowPathIcon aria-hidden="true" /><span>Last Xero sync<strong>{model.lastXeroSync}</strong></span></div>
          </article>
          <article className={`panel connection-panel ${model.xeroHealthy ? 'connection-panel--healthy' : 'connection-panel--attention'}`}>
            <CheckCircleIcon aria-hidden="true" />
            <div>
              <h2>{model.xeroHealthy ? 'Xero connected' : 'Xero needs attention'}</h2>
              <p>{model.xeroHealthy ? 'Invoices, payments and customers are in sync.' : 'Open settings to restore invoice and payment updates.'}</p>
            </div>
          </article>
        </aside>
      </section>
    </div>
  );
}
