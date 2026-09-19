export type ProviderOutcome =
  | { kind: 'accepted'; providerMessageId: string | null }
  | { kind: 'delivered'; providerMessageId: string }
  | { kind: 'rejected'; providerMessageId: string | null; reason: string }
  | { kind: 'unknown' };

export function reconcileSinchStatus(input: {
  messageId: string;
  status: string;
  statusCode: number | null;
}): ProviderOutcome {
  const status = input.status.toUpperCase();
  if (status === 'DELIVERED') {
    return { kind: 'delivered', providerMessageId: input.messageId };
  }
  if (['FAILED', 'REJECTED', 'EXPIRED'].includes(status)) {
    return {
      kind: 'rejected',
      providerMessageId: input.messageId,
      reason:
        input.statusCode === null
          ? status
          : `${status}:${input.statusCode.toString()}`
    };
  }
  if (['QUEUED', 'ACCEPTED', 'SENT'].includes(status)) {
    return { kind: 'accepted', providerMessageId: input.messageId };
  }
  return { kind: 'unknown' };
}
