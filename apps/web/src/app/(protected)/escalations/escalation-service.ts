import { createHash } from 'node:crypto';

import { and, eq } from 'drizzle-orm';

import { authorise, type AppSession } from '@bc5000/auth';
import {
  auditEvents,
  contactChannels,
  contacts,
  type Database,
  PostgresTaskRepository,
  tasks
} from '@bc5000/db/web';
import { selectPreferredSmsChannel } from '@bc5000/domain';

export function createEscalationService(dependencies: { database: Database; clock: { now(): Date } }) {
  const repository = new PostgresTaskRepository(dependencies.database);
  const completeTask = async (session: AppSession, input: { organisationId: string; taskId: string; resolutionNote: string }) => {
    authorise(session, 'chase.operate', input.organisationId);
    const resolutionNote = input.resolutionNote.trim();
    if (resolutionNote === '') throw new Error('RESOLUTION_NOTE_REQUIRED');
    if (/[<>]/.test(resolutionNote)) throw new Error('RESOLUTION_NOTE_MUST_BE_PLAIN_TEXT');
    await repository.complete({ organisationId: input.organisationId, taskId: input.taskId, actorUserId: session.userId, resolutionNote, now: dependencies.clock.now() });
  };
  const recordCallLinkOpened = async (
    session: AppSession,
    input: { organisationId: string; taskId: string }
  ) => {
    authorise(session, 'chase.operate', input.organisationId);
    const [target] = await dependencies.database
      .select({ task: tasks, contact: contacts })
      .from(tasks)
      .innerJoin(
        contacts,
        and(
          eq(contacts.id, tasks.contactId),
          eq(contacts.organisationId, input.organisationId)
        )
      )
      .where(
        and(
          eq(tasks.organisationId, input.organisationId),
          eq(tasks.id, input.taskId),
          eq(tasks.kind, 'DEBT_ESCALATION'),
          eq(tasks.status, 'OPEN')
        )
      )
      .limit(1);
    if (target === undefined) throw new Error('ESCALATION_NOT_FOUND');
    const channels = await dependencies.database
      .select()
      .from(contactChannels)
      .where(
        and(
          eq(contactChannels.organisationId, input.organisationId),
          eq(contactChannels.contactId, target.contact.id),
          eq(contactChannels.kind, 'SMS'),
          eq(contactChannels.usable, true)
        )
      );
    const phone = selectPreferredSmsChannel(channels)?.normalisedValue;
    if (phone === undefined) throw new Error('CALL_PHONE_UNAVAILABLE');
    const now = dependencies.clock.now();
    await dependencies.database.insert(auditEvents).values({
      organisationId: input.organisationId,
      actorUserId: session.userId,
      eventType: 'CALL_LINK_OPENED',
      entityType: 'TASK',
      entityId: input.taskId,
      afterValue: {
        contactId: target.contact.id,
        destinationHash: createHash('sha256').update(phone).digest('hex')
      },
      occurredAt: now
    });
    return { href: `tel:${phone}` };
  };
  return { completeTask, recordCallLinkOpened };
}
