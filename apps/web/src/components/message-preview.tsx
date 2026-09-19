export function MessagePreview({
  channel,
  destination,
  content,
  encoding,
  segmentCount,
  invoiceNumber,
  sourceVersion
}: {
  channel: 'SMS' | 'XERO_EMAIL' | 'TASK';
  destination: string;
  content: string;
  encoding: string;
  segmentCount: number;
  invoiceNumber: string;
  sourceVersion: number;
}) {
  const isXero = channel === 'XERO_EMAIL';
  return (
    <details className="message-preview">
      <summary>Preview exact message</summary>
      <div className="message-preview__meta">
        <span><small>Action</small><strong>{isXero ? 'Submit invoice email to Xero' : channel === 'SMS' ? 'Send SMS via Sinch' : 'Create escalation task'}</strong></span>
        <span><small>Destination</small><strong>{isXero ? 'Xero-managed recipient set' : destination}</strong></span>
        <span><small>Encoding</small><strong>{channel === 'SMS' ? `${encoding} · ${segmentCount} segment${segmentCount === 1 ? '' : 's'}` : 'Provider managed'}</strong></span>
        <span><small>Source</small><strong>{invoiceNumber} · version {sourceVersion}</strong></span>
      </div>
      <div className="message-bubble">{content}</div>
      {isXero && <p className="preview-note">Xero uses its configured invoice email template and recipients. Bill Chaser records “Submitted to Xero”; it does not claim downstream delivery.</p>}
    </details>
  );
}
