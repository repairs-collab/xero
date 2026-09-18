import { authorise, type AppSession } from '@bc5000/auth';
import { type Database, PostgresTaskRepository } from '@bc5000/db/web';

export function createEscalationService(dependencies: { database: Database; clock: { now(): Date } }) {
  const repository = new PostgresTaskRepository(dependencies.database);
  const completeTask = async (session: AppSession, input: { organisationId: string; taskId: string; resolutionNote: string }) => {
    authorise(session, 'chase.operate', input.organisationId);
    const resolutionNote = input.resolutionNote.trim();
    if (resolutionNote === '') throw new Error('RESOLUTION_NOTE_REQUIRED');
    if (/[<>]/.test(resolutionNote)) throw new Error('RESOLUTION_NOTE_MUST_BE_PLAIN_TEXT');
    await repository.complete({ organisationId: input.organisationId, taskId: input.taskId, actorUserId: session.userId, resolutionNote, now: dependencies.clock.now() });
  };
  return { completeTask };
}
