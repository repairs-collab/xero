import type { DebtContactScheduleWindow, ReminderStageChannel } from '@bc5000/domain';

export const smsScheduleChannels = ['SMS', 'SMS_DAILY'] as const;

export const schedulesSms = (channels: readonly ReminderStageChannel[]): boolean =>
  channels.some((channel) => channel === 'SMS' || channel === 'SMS_DAILY');

export interface SequenceScheduleTimes {
  sendTime: string;
  socialWindowStart: string;
  socialWindowEnd: string;
}

export type SmsScheduleIssue =
  | 'SMS_SCHEDULE_TIME_ZONE'
  | 'SMS_SCHEDULE_SOCIAL_WINDOW'
  | 'SMS_SCHEDULE_SEND_TIME';

export type SequenceScheduleIssue =
  | SmsScheduleIssue
  | 'INVALID_TIME'
  | 'INVALID_SOCIAL_WINDOW'
  | 'SEND_TIME_OUTSIDE_SOCIAL_WINDOW';

export function getSmsScheduleIssue(
  times: SequenceScheduleTimes,
  contactWindow: DebtContactScheduleWindow | null
): SmsScheduleIssue | null {
  if (contactWindow === null) return 'SMS_SCHEDULE_TIME_ZONE';
  const { start, end } = contactWindow;
  const sendTime = times.sendTime.slice(0, 5);
  const socialStart = times.socialWindowStart.slice(0, 5);
  const socialEnd = times.socialWindowEnd.slice(0, 5);
  if (socialStart >= socialEnd || socialEnd <= start || socialStart >= end) {
    return 'SMS_SCHEDULE_SOCIAL_WINDOW';
  }
  return sendTime < start || sendTime >= end || sendTime < socialStart || sendTime >= socialEnd
    ? 'SMS_SCHEDULE_SEND_TIME'
    : null;
}

export class SequenceScheduleValidationError extends Error {
  constructor(readonly issue: SequenceScheduleIssue) {
    super(issue);
  }
}
