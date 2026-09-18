import type { PauseScope } from './invoices.js';

export type PauseKind =
  | 'SMS_SUPPRESSION'
  | 'DISPUTE'
  | 'REPLY'
  | 'PROMISE_TO_PAY'
  | 'CUSTOMER'
  | 'INVOICE'
  | 'SEQUENCE';

export interface PauseRecord {
  kind: PauseKind;
  scope: PauseScope;
  active: boolean;
  startedAt: string;
  expiresAt?: string;
  reason?: string;
  actor?: string;
}

export interface PauseInput {
  now: string;
  pauses: PauseRecord[];
}

export type EffectivePause = PauseRecord;

const precedence: Record<PauseKind, number> = {
  SMS_SUPPRESSION: 6,
  DISPUTE: 5,
  REPLY: 5,
  PROMISE_TO_PAY: 4,
  CUSTOMER: 3,
  INVOICE: 2,
  SEQUENCE: 1
};

const isActiveAt = (pause: PauseRecord, now: number): boolean =>
  pause.active &&
  (pause.expiresAt === undefined || Date.parse(pause.expiresAt) > now);

export function resolveEffectivePause(
  input: PauseInput
): EffectivePause | null {
  const now = Date.parse(input.now);
  let selected: PauseRecord | null = null;

  for (const pause of input.pauses) {
    if (!isActiveAt(pause, now)) continue;

    if (
      selected === null ||
      precedence[pause.kind] > precedence[selected.kind] ||
      (precedence[pause.kind] === precedence[selected.kind] &&
        Date.parse(pause.startedAt) > Date.parse(selected.startedAt))
    ) {
      selected = pause;
    }
  }

  return selected;
}
