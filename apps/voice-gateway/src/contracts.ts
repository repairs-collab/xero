import { createHash } from 'node:crypto';

export interface ApprovedVoiceInvoiceFact {
  invoiceNumber: string;
  amountDue: string;
  dueDate: string;
}

export interface ApprovedVoiceFacts {
  accountName: string;
  combinedAmount: string;
  currency: string;
  invoices: readonly ApprovedVoiceInvoiceFact[];
}

export interface CreateGatewayCallCommand {
  version: 1;
  gatewayCallId: string;
  organisationId: string;
  voiceCallId: string;
  idempotencyKey: string;
  provider: 'VOIPCLOUD';
  providerUserNumber: string;
  destinationNumber: string;
  callerId: string;
  flowVersion: number;
  ttsVoiceId: string;
  callbackUrl: string;
  transfer: {
    sipUri?: string;
    fallbackNumber: string;
    label: string;
  };
  approvedFacts: ApprovedVoiceFacts;
}

export interface CreateGatewayCallResponse {
  gatewayCallId: string;
  state: string;
  created: boolean;
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const e164Pattern = /^\+[1-9]\d{7,14}$/;
const decimalPattern = /^(?:0|[1-9]\d{0,15})\.\d{2}$/;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const userNumberPattern = /^\d{1,32}$/;
const idempotencyPattern = /^[A-Za-z0-9._:-]{1,255}$/;
const ttsVoicePattern = /^[A-Za-z0-9._-]{1,128}$/;

const containsControlCharacter = (value: string): boolean =>
  [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const exactKeys = (
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = []
): boolean => {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
};

const boundedSafeText = (
  value: unknown,
  maximumLength: number
): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= maximumLength &&
  !containsControlCharacter(value);

const parseCallbackUrl = (value: unknown): string | undefined => {
  if (typeof value !== 'string' || value.length > 2048) return undefined;
  try {
    const url = new URL(value);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username !== '' ||
      url.password !== '' ||
      url.hash !== ''
    ) {
      return undefined;
    }
    return value;
  } catch {
    return undefined;
  }
};

export const parseCreateGatewayCallCommand = (
  value: unknown,
  supportedFlowVersion: number
): CreateGatewayCallCommand => {
  const command = asRecord(value);
  const requiredKeys = [
    'version',
    'gatewayCallId',
    'organisationId',
    'voiceCallId',
    'idempotencyKey',
    'provider',
    'providerUserNumber',
    'destinationNumber',
    'callerId',
    'flowVersion',
    'ttsVoiceId',
    'callbackUrl',
    'transfer',
    'approvedFacts'
  ] as const;
  if (command === undefined || !exactKeys(command, requiredKeys)) {
    throw new Error('GATEWAY_COMMAND_INVALID');
  }

  const transfer = asRecord(command.transfer);
  const facts = asRecord(command.approvedFacts);
  if (
    transfer === undefined ||
    !exactKeys(transfer, ['fallbackNumber', 'label'], ['sipUri']) ||
    facts === undefined ||
    !exactKeys(facts, [
      'accountName',
      'combinedAmount',
      'currency',
      'invoices'
    ])
  ) {
    throw new Error('GATEWAY_COMMAND_INVALID');
  }

  if (!Array.isArray(facts.invoices) || facts.invoices.length === 0 || facts.invoices.length > 20) {
    throw new Error('GATEWAY_COMMAND_INVALID');
  }
  const invoices: ApprovedVoiceInvoiceFact[] = facts.invoices.map((value) => {
    const invoice = asRecord(value);
    if (
      invoice === undefined ||
      !exactKeys(invoice, ['invoiceNumber', 'amountDue', 'dueDate']) ||
      !boundedSafeText(invoice.invoiceNumber, 100) ||
      typeof invoice.amountDue !== 'string' ||
      !decimalPattern.test(invoice.amountDue) ||
      typeof invoice.dueDate !== 'string' ||
      !datePattern.test(invoice.dueDate) ||
      !Number.isFinite(new Date(`${invoice.dueDate}T00:00:00.000Z`).getTime())
    ) {
      throw new Error('GATEWAY_COMMAND_INVALID');
    }
    return {
      invoiceNumber: invoice.invoiceNumber,
      amountDue: invoice.amountDue,
      dueDate: invoice.dueDate
    };
  });

  const callbackUrl = parseCallbackUrl(command.callbackUrl);
  if (
    command.version !== 1 ||
    !uuidPattern.test(String(command.gatewayCallId)) ||
    !uuidPattern.test(String(command.organisationId)) ||
    !uuidPattern.test(String(command.voiceCallId)) ||
    typeof command.idempotencyKey !== 'string' ||
    !idempotencyPattern.test(command.idempotencyKey) ||
    command.provider !== 'VOIPCLOUD' ||
    typeof command.providerUserNumber !== 'string' ||
    !userNumberPattern.test(command.providerUserNumber) ||
    typeof command.destinationNumber !== 'string' ||
    !e164Pattern.test(command.destinationNumber) ||
    typeof command.callerId !== 'string' ||
    !e164Pattern.test(command.callerId) ||
    command.flowVersion !== supportedFlowVersion ||
    typeof command.ttsVoiceId !== 'string' ||
    !ttsVoicePattern.test(command.ttsVoiceId) ||
    callbackUrl === undefined ||
    (transfer.sipUri !== undefined &&
      (typeof transfer.sipUri !== 'string' ||
        !/^sip:[^\s@]+@[^\s@]+$/i.test(transfer.sipUri))) ||
    typeof transfer.fallbackNumber !== 'string' ||
    !e164Pattern.test(transfer.fallbackNumber) ||
    !boundedSafeText(transfer.label, 120) ||
    !boundedSafeText(facts.accountName, 200) ||
    typeof facts.combinedAmount !== 'string' ||
    !decimalPattern.test(facts.combinedAmount) ||
    typeof facts.currency !== 'string' ||
    !/^[A-Z]{3}$/.test(facts.currency)
  ) {
    throw new Error('GATEWAY_COMMAND_INVALID');
  }

  return {
    version: 1,
    gatewayCallId: command.gatewayCallId as string,
    organisationId: command.organisationId as string,
    voiceCallId: command.voiceCallId as string,
    idempotencyKey: command.idempotencyKey,
    provider: 'VOIPCLOUD',
    providerUserNumber: command.providerUserNumber,
    destinationNumber: command.destinationNumber,
    callerId: command.callerId,
    flowVersion: supportedFlowVersion,
    ttsVoiceId: command.ttsVoiceId,
    callbackUrl,
    transfer: {
      ...(transfer.sipUri === undefined
        ? {}
        : { sipUri: transfer.sipUri }),
      fallbackNumber: transfer.fallbackNumber,
      label: transfer.label
    },
    approvedFacts: {
      accountName: facts.accountName,
      combinedAmount: facts.combinedAmount,
      currency: facts.currency,
      invoices
    }
  };
};

export const hashGatewayCommand = (
  command: CreateGatewayCallCommand
): string =>
  createHash('sha256').update(JSON.stringify(command)).digest('hex');
