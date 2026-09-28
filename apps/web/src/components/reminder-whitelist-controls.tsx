import type { ReminderWhitelistScope } from '@bc5000/db/web';

export type WhitelistFormAction = (
  formData: FormData
) => void | Promise<void>;

export interface ReminderWhitelistListRow {
  entry: {
    id: string;
    scope: ReminderWhitelistScope;
    contactId: string;
    invoiceId: string | null;
    reason: string | null;
    createdAt: Date;
  };
  contactName: string;
  invoiceNumber: string | null;
  createdByName: string | null;
}

export interface ReminderWhitelistSections {
  clients: ReminderWhitelistListRow[];
  invoices: ReminderWhitelistListRow[];
}

const matchesSearch = (
  row: ReminderWhitelistListRow,
  search: string
): boolean => {
  const query = search.trim().toLocaleLowerCase('en-AU');
  if (query === '') return true;
  return [
    row.contactName,
    row.invoiceNumber,
    row.entry.reason,
    row.createdByName
  ].some((value) => value?.toLocaleLowerCase('en-AU').includes(query));
};

export function buildReminderWhitelistSections(
  rows: ReminderWhitelistListRow[],
  search: string
): ReminderWhitelistSections {
  const matching = rows.filter((row) => matchesSearch(row, search));
  return {
    clients: matching.filter((row) => row.entry.scope === 'CLIENT'),
    invoices: matching.filter((row) => row.entry.scope === 'INVOICE')
  };
}

function StopReminderForm({
  action,
  organisationId,
  contactId,
  invoiceId,
  scope
}: {
  action: WhitelistFormAction;
  organisationId: string;
  contactId: string;
  invoiceId?: string;
  scope: ReminderWhitelistScope;
}) {
  const label = scope === 'CLIENT' ? 'client' : 'invoice';
  return (
    <details className="whitelist-control">
      <summary className="button button--quiet">Stop reminders for {label}</summary>
      <form action={action}>
        <input type="hidden" name="organisationId" value={organisationId} />
        <input type="hidden" name="contactId" value={contactId} />
        <input type="hidden" name="scope" value={scope} />
        {invoiceId !== undefined && (
          <input type="hidden" name="invoiceId" value={invoiceId} />
        )}
        <p>
          Current and future reminders will stop immediately. Unsent approvals,
          messages and escalation work for this {label} will be cancelled.
        </p>
        <label>
          Reason (optional)
          <input name="reason" maxLength={500} placeholder="Add a helpful note" />
        </label>
        <label className="manual-confirmation">
          <input name="confirmed" type="checkbox" value="yes" required />
          I confirm reminders should stop immediately
        </label>
        <button className="button button--danger" type="submit">
          Stop reminders for {label}
        </button>
      </form>
    </details>
  );
}

export function ReminderWhitelistControls({
  organisationId,
  contactId,
  invoiceId,
  action
}: {
  organisationId: string;
  contactId: string;
  invoiceId?: string;
  action: WhitelistFormAction;
}) {
  return (
    <div className="whitelist-controls">
      {invoiceId !== undefined && (
        <StopReminderForm
          action={action}
          organisationId={organisationId}
          contactId={contactId}
          invoiceId={invoiceId}
          scope="INVOICE"
        />
      )}
      <StopReminderForm
        action={action}
        organisationId={organisationId}
        contactId={contactId}
        scope="CLIENT"
      />
    </div>
  );
}

const formatDate = (value: Date): string =>
  new Intl.DateTimeFormat('en-AU', {
    dateStyle: 'medium',
    timeZone: 'Australia/Sydney'
  }).format(value);

function SettingsSection({
  title,
  emptyMessage,
  rows,
  organisationId,
  removeAction
}: {
  title: string;
  emptyMessage: string;
  rows: ReminderWhitelistListRow[];
  organisationId: string;
  removeAction: WhitelistFormAction;
}) {
  return (
    <section className="panel whitelist-section">
      <div className="panel__heading">
        <div>
          <span className="eyebrow">Active exclusions</span>
          <h2>{title}</h2>
        </div>
        <span className="status-chip">{rows.length}</span>
      </div>
      {rows.length === 0 ? (
        <p className="whitelist-empty">{emptyMessage}</p>
      ) : (
        <div className="whitelist-list">
          {rows.map((row) => (
            <article className="whitelist-entry" key={row.entry.id}>
              <div>
                <strong>{row.contactName}</strong>
                {row.invoiceNumber !== null && <span>{row.invoiceNumber}</span>}
                <p>{row.entry.reason ?? 'No reason supplied'}</p>
                <small>
                  Added by {row.createdByName ?? 'Unknown user'} on{' '}
                  {formatDate(row.entry.createdAt)}
                </small>
              </div>
              <form action={removeAction}>
                <input type="hidden" name="organisationId" value={organisationId} />
                <input type="hidden" name="entryId" value={row.entry.id} />
                <label className="manual-confirmation">
                  <input name="confirmed" type="checkbox" value="yes" required />
                  I understand eligible reminders will resume immediately
                </label>
                <button className="button button--danger" type="submit">
                  Remove and resume chasing
                </button>
              </form>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

export function ReminderWhitelistSettingsList({
  organisationId,
  sections,
  removeAction
}: {
  organisationId: string;
  sections: ReminderWhitelistSections;
  removeAction: WhitelistFormAction;
}) {
  return (
    <div className="whitelist-settings-grid">
      <SettingsSection
        title="Clients"
        emptyMessage="No clients match this search."
        rows={sections.clients}
        organisationId={organisationId}
        removeAction={removeAction}
      />
      <SettingsSection
        title="Invoices"
        emptyMessage="No invoices match this search."
        rows={sections.invoices}
        organisationId={organisationId}
        removeAction={removeAction}
      />
    </div>
  );
}
