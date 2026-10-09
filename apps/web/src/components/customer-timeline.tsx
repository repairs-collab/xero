export interface TimelineEvent {
  id: string;
  occurredAt: string;
  label: string;
  source: string;
  detail: string;
  tone?: 'neutral' | 'positive' | 'warning';
  href?: string;
  actionLabel?: string;
  links?: Array<{ href: string; label: string }>;
}

export function CustomerTimeline({ events }: { events: TimelineEvent[] }) {
  const ordered = [...events].sort((left, right) => right.occurredAt.localeCompare(left.occurredAt) || right.id.localeCompare(left.id));
  if (ordered.length === 0) return <div className="empty-state compact"><span><ArrowPathIcon aria-hidden="true" /></span><h2>No activity yet</h2><p>Customer events will appear here.</p></div>;
  return <ol className="customer-timeline">{ordered.map((event) => <li key={event.id} data-testid="timeline-event" className={`timeline-event timeline-event--${event.tone ?? 'neutral'}`}><span className="timeline-event__dot" /><div className="timeline-event__header"><strong>{event.label}</strong><span>{new Intl.DateTimeFormat('en-AU', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Australia/Sydney' }).format(new Date(event.occurredAt))}</span></div><p>{event.detail}</p>{event.links && event.links.length > 0 ? <div className="timeline-event__links">{event.links.map((link) => <a key={`${event.id}:${link.href}`} href={link.href}>{link.label}</a>)}</div> : null}<small>{event.source}</small>{event.href && event.actionLabel ? <a href={event.href}>{event.actionLabel}</a> : null}</li>)}</ol>;
}
import { ArrowPathIcon } from '@heroicons/react/24/outline';
