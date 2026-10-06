import { describe, expect, it, vi } from 'vitest';

import type { SinchReplyEvent } from '@bc5000/integrations/sinch';

import {
  assertInboundReplyRecoveryComplete,
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

  it('confirms but does not import replies deliberately skipped by the reset boundary', async () => {
    const checkReplies = vi
      .fn<() => Promise<SinchReplyEvent[]>>()
      .mockResolvedValueOnce([reply('stale'), reply('current')])
      .mockResolvedValueOnce([]);
    const confirmReplies = vi.fn(() => Promise.resolve());
    const processReply = vi.fn(
      (event: SinchReplyEvent): Promise<'processed' | 'skipped'> =>
        Promise.resolve(
          event.replyId === 'stale' ? 'skipped' : 'processed'
        )
    );
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
      processed: 1,
      skipped: 1
    });
    expect(confirmReplies).toHaveBeenCalledWith(['stale', 'current']);
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
