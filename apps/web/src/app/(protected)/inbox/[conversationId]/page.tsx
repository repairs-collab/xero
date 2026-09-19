import { headers } from 'next/headers';
import { notFound } from 'next/navigation';

import { PostgresConversationRepository } from '@bc5000/db/web';

import { ConversationThread, type ConversationMessage } from '../../../../components/conversation-thread.js';
import { getDatabaseClient, requireWebSession } from '../../../../server/runtime.js';

export default async function ConversationPage({ params }: { params: Promise<{ conversationId: string }> }) {
  const { conversationId } = await params; const session = await requireWebSession(new Request('http://localhost/', { headers: await headers() })); const organisationId = session.memberships[0]?.organisationId; if (!organisationId) throw new Error('No active organisation membership');
  const thread = await new PostgresConversationRepository(getDatabaseClient().db).thread(organisationId, conversationId); if (!thread) notFound();
  const messages: ConversationMessage[] = [...thread.inbound.map((message) => ({ id: message.id, direction: 'INBOUND' as const, content: message.body, occurredAt: message.receivedAt.toISOString() })), ...thread.outbound.map((reply) => ({ id: reply.id, direction: 'OUTBOUND' as const, content: reply.content, occurredAt: reply.createdAt.toISOString(), status: reply.status }))];
  return <div className="page-stack"><a className="back-link" href="/inbox">← Back to inbox</a><ConversationThread organisationId={organisationId} conversationId={conversationId} customerName={thread.contact.name} number={thread.conversation.normalisedNumber} messages={messages} suppression={thread.suppression ? { source: thread.suppression.source, reason: thread.suppression.reason } : null}/></div>;
}
