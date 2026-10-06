import type { SinchReplyEvent } from '@bc5000/integrations/sinch';

interface InboundReplyRecoveryDependencies {
  sinch: {
    checkReplies(): Promise<SinchReplyEvent[]>;
    confirmReplies(replyIds: string[]): Promise<void>;
  };
  processReply(event: SinchReplyEvent): Promise<'processed' | 'skipped'>;
  maxBatches?: number;
}

export interface InboundReplyRecoveryFailure {
  replyId: string;
  reason: 'UNMATCHED_CUSTOMER' | 'PROCESSING_FAILED';
}

export interface InboundReplyRecoveryResult {
  batches: number;
  confirmed: number;
  drained: boolean;
  failed: number;
  failures: InboundReplyRecoveryFailure[];
  processed: number;
  skipped: number;
}

export function assertInboundReplyRecoveryComplete(
  result: InboundReplyRecoveryResult
): void {
  if (result.failed > 0 || !result.drained) {
    throw new Error(
      `INBOUND_REPLY_RECOVERY_INCOMPLETE failed=${result.failed.toString()} drained=${String(result.drained)}`
    );
  }
}

export function createInboundReplyRecoveryService(
  dependencies: InboundReplyRecoveryDependencies
) {
  const run = async (): Promise<InboundReplyRecoveryResult> => {
    const attempted = new Set<string>();
    const failures = new Map<
      string,
      InboundReplyRecoveryFailure['reason']
    >();
    let batches = 0;
    let confirmed = 0;
    let drained = false;
    let processed = 0;
    let skipped = 0;

    const maxBatches = dependencies.maxBatches ?? 100;
    for (let batchIndex = 0; batchIndex < maxBatches; batchIndex += 1) {
      const replies = await dependencies.sinch.checkReplies();
      if (replies.length === 0) {
        drained = true;
        break;
      }
      batches += 1;
      const confirmedIds: string[] = [];
      for (const reply of replies) {
        if (attempted.has(reply.replyId)) continue;
        attempted.add(reply.replyId);
        try {
          const outcome = await dependencies.processReply(reply);
          if (outcome === 'processed') processed += 1;
          else skipped += 1;
          confirmedIds.push(reply.replyId);
        } catch (error) {
          failures.set(
            reply.replyId,
            error instanceof Error &&
              error.message ===
                'Inbound reply number could not be matched to a customer'
              ? 'UNMATCHED_CUSTOMER'
              : 'PROCESSING_FAILED'
          );
        }
      }
      if (confirmedIds.length === 0) break;
      await dependencies.sinch.confirmReplies(confirmedIds);
      confirmed += confirmedIds.length;
    }

    return {
      batches,
      confirmed,
      drained,
      failed: failures.size,
      failures: [...failures].map(([replyId, reason]) => ({ replyId, reason })),
      processed,
      skipped
    };
  };

  return { run };
}
