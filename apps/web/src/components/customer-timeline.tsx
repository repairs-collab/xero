export interface TimelineEvent {
  id: string;
  occurredAt: string;
  label: string;
  source: string;
  detail: string;
  tone?: 'neutral' | 'positive' | 'warning';
}

export function CustomerTimeline({ events }: { events: TimelineEvent[] }) {
  const ordered = [...events].sort((left, right) => right.occurredAt.localeCompare(left.occurredAt) || right.id.localeCompare(left.id));
  if (ordered.length === 0) return <div className="empty-state compact"><span>↺</span><h2>No activity yet</h2><p>Customer events will appear here.</p></div>;
  return <ol className="customer-timeline">{ordered.map((event) => <li key={event.id} data-testid="timeline-event" className={`timeline-event timeline-event--${event.tone ?? 'neutral'}`}><span className="timeline-event__dot" /><div className="timeline-event__header"><strong>{event.label}</strong><span>{new Intl.DateTimeFormat('en-AU', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Australia/Sydney' }).format(new Date(event.occurredAt))}</span></div><p>{event.detail}</p><small>{event.source}</small></li>)}</ol>;
}
