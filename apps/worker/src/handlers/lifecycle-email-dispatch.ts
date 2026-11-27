import type { ClaimedLifecycleEmail, PostgresLifecycleEmailRepository } from '@bc5000/db';
import type { JobPayloads } from '@bc5000/jobs';
import type { JobContext } from '../register-handlers.js';
import type { LifecycleEmailDeliveryConfiguration } from '../runtime-config.js';
import type {
  LifecycleEmailClientConfig, LifecycleEmailNotice, LifecycleEmailOutcome
} from '@bc5000/integrations/email';

type DispatchRepository = Pick<PostgresLifecycleEmailRepository,
  'expireDue' | 'quarantineStaleSending' | 'claimNext' | 'recordSent' | 'recordRetry' | 'recordFailed' | 'recordUnknown'>;
interface EmailClient {
  send(notice: LifecycleEmailNotice): Promise<LifecycleEmailOutcome>;
}

const retryDelayMinutes = [1, 5, 15, 60] as const;
const claimBudgetMs = 75_000;
const staleCutoff = (now: Date) => new Date(now.getTime() - 15 * 60_000);

async function confirmWrite(result: Promise<boolean>): Promise<void> {
  const recorded = await result.catch(() => {
    throw new Error('LIFECYCLE_EMAIL_OUTCOME_WRITE_FAILED');
  });
  if (!recorded) throw new Error('LIFECYCLE_EMAIL_CLAIM_LOST');
}

function recordOutcome(
  repository: DispatchRepository,
  claim: ClaimedLifecycleEmail,
  outcome: LifecycleEmailOutcome,
  now: Date
): Promise<boolean> {
  const token = { id: claim.id, claimToken: claim.claimToken, now };
  switch (outcome.status) {
    case 'SENT':
      return repository.recordSent({
        ...token,
        messageId: outcome.messageId,
        providerMessageId: outcome.providerMessageId ?? null
      });
    case 'UNKNOWN':
      return repository.recordUnknown({ ...token, failureCode: outcome.failureCode });
    case 'FAILED':
      return repository.recordFailed({ ...token, failureCode: outcome.failureCode });
    case 'RETRY': {
      const delay = retryDelayMinutes[claim.attempts - 1];
      if (delay === undefined) return repository.recordFailed({ ...token, failureCode: outcome.failureCode });
      return repository.recordRetry({ ...token, failureCode: outcome.failureCode,
        nextAttemptAt: new Date(now.getTime() + delay * 60_000) });
    }
  }
}

export function createLifecycleEmailDispatchHandler({ repository, config, createClient, clock }: {
  repository: DispatchRepository;
  config: LifecycleEmailDeliveryConfiguration | null;
  createClient: (config: LifecycleEmailClientConfig) => EmailClient;
  clock: { now(): Date };
}) {
  let client: EmailClient | undefined;
  return async (_payload?: JobPayloads['lifecycle-email.dispatch'], context?: JobContext) => {
    const startedAt = clock.now();
    await repository.expireDue({ now: startedAt });
    await repository.quarantineStaleSending({ now: startedAt, staleBefore: staleCutoff(startedAt) });
    if (config === null || startedAt < config.activatedAt) return;
    if (!client) {
      try {
        client = createClient(config.smtp);
      } catch {
        throw new Error('LIFECYCLE_EMAIL_INVALID_CONFIGURATION');
      }
    }
    const deadline = startedAt.getTime() + claimBudgetMs;
    const mustStop = (at: Date) => context?.signal.aborted || at.getTime() >= deadline;
    for (let count = 0; count < 20; count++) {
      const now = clock.now();
      if (mustStop(now)) return;
      const claim = await repository.claimNext({
        now, staleBefore: staleCutoff(now), activatedAt: config.activatedAt
      });
      if (!claim) return;

      const claimedAt = clock.now();
      if (mustStop(claimedAt) || claim.expiresAt <= claimedAt) {
        await confirmWrite(repository.recordRetry({
          id: claim.id, claimToken: claim.claimToken, now: claimedAt,
          failureCode: 'JOB_CANCELLED_BEFORE_SUBMISSION',
          nextAttemptAt: new Date(claimedAt.getTime() + 1_000)
        }));
        return;
      }

      const { recipient, template, templateVersion, renderData } = claim;
      let outcome: LifecycleEmailOutcome;
      try {
        outcome = await client.send({ recipient, template, templateVersion, renderData });
      } catch {
        outcome = { status: 'UNKNOWN', failureCode: 'SMTP_SUBMISSION_UNCERTAIN' };
      }
      await confirmWrite(recordOutcome(repository, claim, outcome, clock.now()));
    }
  };
}
