import { authorise, type AppSession } from '@bc5000/auth';
import {
  type Database,
  PostgresConversationRepository,
  PostgresOrganisationSafetyRepository
} from '@bc5000/db/web';
import { jobNames, type JobPublisher } from '@bc5000/jobs';

export function createInboxService(dependencies: { database: Database; publisher: JobPublisher; clock: { now(): Date } }) {
  const repository = new PostgresConversationRepository(dependencies.database);
  const safety = new PostgresOrganisationSafetyRepository(dependencies.database);
  const sendOperatorReply = async (session: AppSession, input: { organisationId: string; conversationId: string; content: string }) => {
    authorise(session, 'chase.operate', input.organisationId);
    const content = input.content.trim();
    if (content.length === 0) throw new Error('REPLY_CONTENT_REQUIRED');
    if (content.length > 1_000) throw new Error('REPLY_CONTENT_TOO_LONG');
    const replyId = await dependencies.database.transaction(async (transaction) => {
      await safety.assertOperationalMutationAllowed(
        transaction,
        input.organisationId
      );
      return repository.queueReply(
        { organisationId: input.organisationId, conversationId: input.conversationId, actorUserId: session.userId, content, now: dependencies.clock.now() },
        transaction
      );
    });
    await dependencies.publisher.publish(jobNames.operatorReplyExecute, { organisationId: input.organisationId, replyId }, { singletonKey: `operator-reply:${replyId}` });
    return { replyId };
  };
  return { sendOperatorReply };
}
