import type { ReactNode } from 'react';

export function KpiCard({
  eyebrow,
  value,
  detail,
  accent = 'neutral',
  icon
}: {
  eyebrow: string;
  value: string;
  detail: string;
  accent?: 'neutral' | 'amber' | 'green' | 'blue';
  icon: ReactNode;
}) {
  return (
    <article className={`kpi-card kpi-card--${accent}`}>
      <div className="kpi-card__topline">
        <span className="kpi-card__eyebrow">{eyebrow}</span>
        <span className="kpi-card__icon" aria-hidden="true">{icon}</span>
      </div>
      <strong className="kpi-card__value">{value}</strong>
      <span className="kpi-card__detail">{detail}</span>
    </article>
  );
}
