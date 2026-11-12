import type { SmsNumberStatus } from '@bc5000/db/web';

export interface CustomerReplyNumberValue {
  e164Number: string;
  status: SmsNumberStatus;
}

const formattedNumber = (value: string): string => {
  const match = /^\+61(\d)(\d{2})(\d{3})(\d{3})$/.exec(value);
  return match === null
    ? value
    : `+61 ${match[1]}${match[2]} ${match[3]} ${match[4]}`;
};

const statusCopy: Record<SmsNumberStatus, string> = {
  AVAILABLE: 'Being prepared',
  RESERVED: 'Being connected',
  READY: 'Ready for replies',
  QUARANTINED: 'Temporarily unavailable',
  RELEASED: 'Being replaced'
};

export function CustomerReplyNumber({
  number
}: {
  number: CustomerReplyNumberValue | null;
}) {
  if (number === null) {
    return (
      <aside className="reply-number-card" aria-label="AccountPulse reply number">
        <span>AccountPulse reply number</span>
        <strong>Your reply number is being prepared</strong>
        <small>AccountPulse will show it here when it is ready.</small>
      </aside>
    );
  }

  return (
    <aside className="reply-number-card" aria-label="AccountPulse reply number">
      <span>AccountPulse reply number</span>
      <strong>{formattedNumber(number.e164Number)}</strong>
      <small>{statusCopy[number.status]}</small>
    </aside>
  );
}
