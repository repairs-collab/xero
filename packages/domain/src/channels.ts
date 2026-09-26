export interface SmsChannelCandidate {
  id: string;
  usable: boolean;
  approvedOverride: boolean;
}

export function selectPreferredSmsChannel<T extends SmsChannelCandidate>(
  channels: T[]
): T | undefined {
  return channels
    .filter((channel) => channel.usable)
    .sort(
      (left, right) =>
        Number(right.approvedOverride) - Number(left.approvedOverride) ||
        left.id.localeCompare(right.id)
    )[0];
}
