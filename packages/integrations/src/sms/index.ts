export interface SmsSendInput {
  content: string;
  destinationNumber: string;
  sourceNumber?: string;
  callbackUrl: string;
  metadata: Record<string, string>;
}

export type SmsSubmitResult = {
  kind: 'accepted';
  messageId: string;
  status: string;
};

/** Provider-neutral boundary used by worker send paths. */
export interface SmsProvider {
  sendSms(input: SmsSendInput): Promise<SmsSubmitResult>;
}
