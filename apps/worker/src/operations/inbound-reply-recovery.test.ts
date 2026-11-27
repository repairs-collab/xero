import { describe, expect, it, vi } from 'vitest';

import type { SinchReplyEvent } from '@bc5000/integrations/sinch';

import {
  assertInboundReplyRecoveryComplete,
  createInboundReplyRecoveryProcessor,
  createInboundReplyRecoveryService
} from './inbound-reply-recovery.js';

const reply = (replyId: string): SinchReplyEvent => ({
  kind: 'reply',
  replyId,
  from: '+61400000001',
  to: '+61400000002',
  receivedAt: '2026-10-05T01:02:03Z',
  content: `Reply ${replyId}`,
  metadata: {}
});

describe('inbound reply recovery', () => {
  it('processes, confirms, and drains unconfirmed replies in batches', async () => {
    const checkReplies = vi
      .fn<() => Promise<SinchReplyEvent[]>>()
      .mockResolvedValueOnce([reply('reply-1'), reply('reply-2')])
      .mockResolvedValueOnce([]);
    const confirmReplies = vi.fn(() => Promise.resolve());
    const processReply = vi.fn(() => Promise.resolve('processed' as const));
    const service = createInboundReplyRecoveryService({
      sinch: { checkReplies, confirmReplies },
      processReply
    });

    await expect(service.run()).resolves.toEqual({
      batches: 1,
      confirmed: 2,
      drained: true,
      failed: 0,
      failures: [],
      processed: 2,
      skipped: 0
    });
    expect(processReply).toHaveBeenCalledTimes(2);
    expect(confirmReplies).toHaveBeenCalledWith(['reply-1', 'reply-2']);
  });

  it('does not confirm a reply that could not be matched and stops safely', async () => {
    const checkReplies = vi.fn(() =>
      Promise.resolve([reply('reply-1'), reply('reply-2')])
    );
    const confirmReplies = vi.fn(() => Promise.resolve());
    const processReply = vi.fn((event: SinchReplyEvent) =>
      event.replyId === 'reply-2'
        ? Promise.reject(new Error('no matching customer'))
        : Promise.resolve('processed' as const)
    );
    const service = createInboundReplyRecoveryService({
      sinch: { checkReplies, confirmReplies },
      processReply
    });

    await expect(service.run()).resolves.toEqual({
      batches: 2,
      confirmed: 1,
      drained: false,
      failed: 1,
      failures: [
        { replyId: 'reply-2', reason: 'PROCESSING_FAILED' }
      ],
      processed: 1,
      skipped: 0
    });
    expect(confirmReplies).toHaveBeenCalledTimes(1);
    expect(confirmReplies).toHaveBeenCalledWith(['reply-1']);
    expect(checkReplies).toHaveBeenCalledTimes(2);
  });

  it('confirms a scoped pre-reset reply whose outbound attempt was deleted', async () => {
    const accountId = 'workspace-account';
    const stale = { ...reply('stale'), accountId, messageId: 'deleted-attempt' };
    const otherAccount = { ...reply('other-account'), accountId: 'different-account' };
    const missingAccount = reply('missing-account');
    const invalidDate = { ...reply('invalid-date'), accountId, receivedAt: 'invalid' };
    const current = {
      ...reply('current'),
      accountId,
      messageId: 'missing-current-attempt',
      receivedAt: '2026-10-05T01:02:04Z'
    };
    const checkReplies = vi
      .fn<() => Promise<SinchReplyEvent[]>>()
      .mockResolvedValueOnce([stale, otherAccount, missingAccount, invalidDate, current])
      .mockResolvedValueOnce([otherAccount, missingAccount, invalidDate, current]);
    const confirmReplies = vi.fn(() => Promise.resolve());
    const importReply = vi.fn(() => Promise.resolve());
    const service = createInboundReplyRecoveryService({
      sinch: { checkReplies, confirmReplies },
      processReply: createInboundReplyRecoveryProcessor({
        organisationId: 'workspace',
        accountId,
        resetCompletedAt: new Date('2026-10-05T01:02:03Z'),
        resolveSharedEvent: (event) => Promise.resolve(
          event.replyId === 'invalid-date'
            ? { kind: 'shared', organisationId: 'workspace', contactId: 'contact' }
            : { kind: 'pending' }
        ),
        importReply
      })
    });

    await expect(service.run()).resolves.toEqual({
      batches: 2,
      confirmed: 1,
      drained: false,
      failed: 4,
      failures: [
        { replyId: 'other-account', reason: 'PROCESSING_FAILED' },
        { replyId: 'missing-account', reason: 'PROCESSING_FAILED' },
        { replyId: 'invalid-date', reason: 'PROCESSING_FAILED' },
        { replyId: 'current', reason: 'PROCESSING_FAILED' }
      ],
      processed: 0,
      skipped: 1
    });
    expect(confirmReplies).toHaveBeenCalledExactlyOnceWith(['stale']);
    expect(importReply).not.toHaveBeenCalled();
  });

  it('signals incomplete recovery for failures and for the batch safety cap', async () => {
    expect(() =>
      assertInboundReplyRecoveryComplete({
        batches: 1,
        confirmed: 0,
        drained: false,
        failed: 1,
        failures: [
          { replyId: 'reply-1', reason: 'UNMATCHED_CUSTOMER' }
        ],
        processed: 0,
        skipped: 0
      })
    ).toThrow('INBOUND_REPLY_RECOVERY_INCOMPLETE');

    const service = createInboundReplyRecoveryService({
      sinch: {
        checkReplies: () => Promise.resolve([reply('reply-1')]),
        confirmReplies: () => Promise.resolve()
      },
      processReply: () => Promise.resolve('processed'),
      maxBatches: 1
    });
    const capped = await service.run();
    expect(capped.drained).toBe(false);
    expect(() => assertInboundReplyRecoveryComplete(capped)).toThrow(
      'INBOUND_REPLY_RECOVERY_INCOMPLETE'
    );
  });
});
