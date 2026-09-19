import { headers } from 'next/headers';
import Link from 'next/link';

import { PostgresConversationRepository } from '@bc5000/db/web';

import { getDatabaseClient, requireWebSession } from '../../../server/runtime.js';

export default async function InboxPage() {
  const session = await requireWebSession(new Request('http://localhost/', { headers: await headers() })); const organisationId = session.memberships[0]?.organisationId; if (!organisationId) throw new Error('No active organisation membership');
  const rows = await new PostgresConversationRepository(getDatabaseClient().db).list(organisationId);
  return <div className="page-stack"><header className="page-heading"><span className="eyebrow">Two-way SMS</span><h1>Inbox</h1><p>Replies are shared with the team and automatically pause customer chasing.</p></header><section className="inbox-list">{rows.length === 0 ? <div className="empty-state"><span>✉</span><h2>No conversations yet</h2><p>Customer replies from Sinch will appear here.</p></div> : rows.map(({ conversation, contact }) => <Link href={`/inbox/${conversation.id}`} className="inbox-row" key={conversation.id}><div className="avatar">{contact.name.slice(0,2).toUpperCase()}</div><div><strong>{contact.name}</strong><span>{conversation.normalisedNumber}</span></div><time>{new Intl.DateTimeFormat('en-AU', { dateStyle:'medium', timeStyle:'short', timeZone:'Australia/Sydney' }).format(conversation.lastMessageAt)}</time>{conversation.assignedUserId && <span className="assigned-badge">Assigned</span>}{conversation.unreadCount > 0 && <span className="unread-badge">{conversation.unreadCount}</span>}<span className="chevron">›</span></Link>)}</section></div>;
}
