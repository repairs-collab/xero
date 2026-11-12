import { ChatBubbleLeftRightIcon, ChevronRightIcon } from '@heroicons/react/24/outline';
import { and, eq, inArray } from 'drizzle-orm';
import { headers } from 'next/headers';
import Link from 'next/link';

import {
  PostgresConversationRepository,
  smsNumberPool
} from '@bc5000/db/web';

import { CustomerReplyNumber } from '../../../components/customer-reply-number.js';
import { getDatabaseClient, requireWebSession } from '../../../server/runtime.js';

export default async function InboxPage() {
  const session = await requireWebSession(
    new Request('http://localhost/', { headers: await headers() })
  );
  const organisationId = session.memberships[0]?.organisationId;
  if (!organisationId) throw new Error('No active organisation membership');
  const database = getDatabaseClient().db;
  const [rows, [replyNumber]] = await Promise.all([
    new PostgresConversationRepository(database).list(organisationId),
    database
      .select({
        e164Number: smsNumberPool.e164Number,
        status: smsNumberPool.status
      })
      .from(smsNumberPool)
      .where(
        and(
          eq(smsNumberPool.organisationId, organisationId),
          inArray(smsNumberPool.status, ['RESERVED', 'READY', 'QUARANTINED'])
        )
      )
      .limit(1)
  ]);

  return (
    <div className="page-stack">
      <header className="page-heading page-heading--split">
        <div>
          <span className="eyebrow">Two-way SMS</span>
          <h1>Inbox</h1>
          <p>Replies are shared with the team and automatically pause customer chasing.</p>
        </div>
        <CustomerReplyNumber number={replyNumber ?? null} />
      </header>
      <section className="inbox-list">
        {rows.length === 0 ? (
          <div className="empty-state">
            <span><ChatBubbleLeftRightIcon aria-hidden="true" /></span>
            <h2>No conversations yet</h2>
            <p>Customer replies to your AccountPulse number will appear here.</p>
          </div>
        ) : rows.map(({ conversation, contact }) => (
          <Link href={`/inbox/${conversation.id}`} className="inbox-row" key={conversation.id}>
            <div className="avatar">{contact.name.slice(0, 2).toUpperCase()}</div>
            <div><strong>{contact.name}</strong><span>{conversation.normalisedNumber}</span></div>
            <time>{new Intl.DateTimeFormat('en-AU', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Australia/Sydney' }).format(conversation.lastMessageAt)}</time>
            {conversation.assignedUserId && <span className="assigned-badge">Assigned</span>}
            {conversation.unreadCount > 0 && <span className="unread-badge">{conversation.unreadCount}</span>}
            <ChevronRightIcon className="chevron" aria-hidden="true" />
          </Link>
        ))}
      </section>
    </div>
  );
}
