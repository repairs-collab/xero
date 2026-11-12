import Link from 'next/link';

import type { RetentionOperationsPage } from '../../server/retention-operations.js';

const label = (value: string): string =>
  value
    .toLocaleLowerCase('en-AU')
    .replaceAll('_', ' ')
    .replace(/^./u, (character) => character.toLocaleUpperCase('en-AU'));

const date = (value: Date): string =>
  new Intl.DateTimeFormat('en-AU', {
    dateStyle: 'medium',
    timeZone: 'Australia/Sydney'
  }).format(value);

export function PlatformRetentionOperations({
  page,
  organisationId,
  feedbackCode,
  actions
}: {
  page: RetentionOperationsPage;
  organisationId: string;
  feedbackCode?: string;
  actions: {
    recordVerifiedRequest: (formData: FormData) => Promise<void>;
    reviewRequest: (formData: FormData) => Promise<void>;
    recordBackupExpiryVerification: (formData: FormData) => Promise<void>;
    completeExportRequest: (formData: FormData) => Promise<void>;
  };
}) {
  return (
    <div className="platform-page-stack">
      <header className="platform-page-heading">
        <div>
          <span className="eyebrow">Privacy operations</span>
          <h1>Retention &amp; privacy requests</h1>
          <p>
            Track five-year deletion eligibility and the 14-day target for
            verified export or deletion requests. Legal holds, required
            billing/audit evidence and unverified backup ageing always stop a
            deletion review.
          </p>
          <strong>No automatic deletion</strong>
        </div>
      </header>

      {feedbackCode ? (
        <p className="panel" role="status">
          {feedbackCode === 'UPDATED'
            ? 'Retention work item updated.'
            : 'The retention work item was not changed.'}
        </p>
      ) : null}

      <section className="panel platform-table-panel">
        <form className="platform-filters" method="get">
          <strong>Filter retention work</strong>
          <label>
            Customer ID
            <input
              name="organisationId"
              defaultValue={organisationId}
              placeholder="Exact customer ID"
            />
          </label>
          <button className="button button--primary" type="submit">
            Apply filter
          </button>
        </form>
      </section>

      <section className="panel platform-table-panel">
        <header className="platform-page-heading">
          <div>
            <span className="eyebrow">Verified intake</span>
            <h2>Record verified request</h2>
            <p>
              Use opaque case references only. Do not enter request content,
              identity documents or other personal information.
            </p>
          </div>
        </header>
        <form action={actions.recordVerifiedRequest} className="platform-filters">
          <label>
            Customer ID
            <input name="organisationId" required />
          </label>
          <label>
            Request type
            <select name="requestType" defaultValue="EXPORT">
              <option value="EXPORT">Export</option>
              <option value="DELETION">Deletion</option>
            </select>
          </label>
          <label>
            Verification case reference
            <input name="verificationReference" required pattern="[A-Za-z0-9][A-Za-z0-9._-]*" />
          </label>
          <label>
            Retry key
            <input name="idempotencyKey" required pattern="[A-Za-z0-9][A-Za-z0-9._-]*" />
          </label>
          <label>
            Verified at (UTC)
            <input name="verifiedAt" type="datetime-local" required />
          </label>
          <button className="button button--primary" type="submit">
            Record verified request
          </button>
        </form>
      </section>

      <section className="panel platform-table-panel">
        <header className="platform-page-heading">
          <div>
            <span className="eyebrow">Account closure</span>
            <h2>Five-year deletion eligibility</h2>
          </div>
        </header>
        <div className="platform-audit-list">
          {page.retentionCases.map((item) => (
            <article key={item.organisationId}>
              <header>
                <div>
                  <strong>{label(item.status)}</strong>
                  <Link href={`/platform-admin/organisations/${item.organisationId}`}>
                    {item.organisationName}
                  </Link>
                </div>
                <time>{date(item.updatedAt)}</time>
              </header>
              <p>
                {item.deletionEligibleAt
                  ? `Eligible from ${date(item.deletionEligibleAt)}`
                  : 'No approved deletion-eligibility date recorded'}
              </p>
              <div className="platform-audit-meta">
                <span>{label(item.source)}</span>
                <span>Closure episode {item.closureVersion}</span>
                <span>
                  {item.backupExpiryVerifiedAt
                    ? `Backup ageing reviewed ${date(item.backupExpiryVerifiedAt)}`
                    : 'Backup ageing unverified'}
                </span>
              </div>
              <form
                action={actions.recordBackupExpiryVerification}
                className="platform-filters"
              >
                <input
                  type="hidden"
                  name="organisationId"
                  value={item.organisationId}
                />
                <input
                  type="hidden"
                  name="expectedUpdatedAt"
                  value={item.updatedAt.toISOString()}
                />
                <input
                  type="hidden"
                  name="closureEpisodeId"
                  value={item.closureEpisodeId}
                />
                <input
                  type="hidden"
                  name="operationId"
                  value={`backup-${item.closureEpisodeId}-v${item.closureVersion}`}
                />
                <label>
                  Backup review completed at (UTC)
                  <input name="verifiedAt" type="datetime-local" required />
                </label>
                <label>
                  Opaque evidence reference
                  <input
                    name="evidenceReference"
                    required
                    pattern="[A-Za-z0-9][A-Za-z0-9._-]*"
                  />
                </label>
                <label>
                  Review reason
                  <input name="reason" required maxLength={500} />
                </label>
                <button className="button" type="submit">
                  Record backup-ageing evidence
                </button>
              </form>
            </article>
          ))}
          {page.retentionCases.length === 0 ? (
            <p className="platform-empty">No retention cases matched this filter.</p>
          ) : null}
        </div>
      </section>

      <section className="panel platform-table-panel">
        <header className="platform-page-heading">
          <div>
            <span className="eyebrow">Service target</span>
            <h2>Verified requests · 14-day target</h2>
          </div>
        </header>
        <div className="platform-audit-list">
          {page.dataRequests.map((item) => (
            <article key={item.id}>
              <header>
                <div>
                  <strong>
                    {label(item.requestType)} · {label(item.status)}
                  </strong>
                  <Link href={`/platform-admin/organisations/${item.organisationId}`}>
                    {item.organisationName}
                  </Link>
                </div>
                <time>Target {date(item.targetAt)}</time>
              </header>
              <p>{item.verificationReference}</p>
              <div className="platform-audit-meta">
                <span>Verified {date(item.verifiedAt)}</span>
                <span>
                  {item.blockReason ? label(item.blockReason) : 'No recorded block'}
                </span>
                <span>Version {item.version}</span>
                {item.completedAt ? (
                  <span>Completed {date(item.completedAt)}</span>
                ) : null}
              </div>
              {item.completedAt ? (
                <p>
                  Export delivery reference: {item.completionReference ?? 'Recorded'}
                </p>
              ) : (
                <>
                  <form action={actions.reviewRequest} className="platform-filters">
                    <input type="hidden" name="organisationId" value={item.organisationId} />
                    <input type="hidden" name="requestId" value={item.id} />
                    <input type="hidden" name="expectedVersion" value={item.version} />
                    <input
                      type="hidden"
                      name="operationId"
                      value={`review-${item.id}-v${item.version}`}
                    />
                    <label>
                      Review reason
                      <input name="reason" required maxLength={500} />
                    </label>
                    <button className="button" type="submit">
                      Re-evaluate safeguards
                    </button>
                  </form>
                  {item.requestType === 'EXPORT' &&
                  ['VERIFIED', 'IN_REVIEW'].includes(item.status) ? (
                    <div className="platform-page-stack">
                      <Link
                        className="button"
                        href={`/platform-admin/organisations/${item.organisationId}/backup?requestId=${item.id}`}
                      >
                        Download request export
                      </Link>
                      <form
                        action={actions.completeExportRequest}
                        className="platform-filters"
                      >
                        <input type="hidden" name="organisationId" value={item.organisationId} />
                        <input type="hidden" name="requestId" value={item.id} />
                        <input type="hidden" name="expectedVersion" value={item.version} />
                        <input
                          type="hidden"
                          name="operationId"
                          value={`complete-${item.id}-v${item.version}`}
                        />
                        <label>
                          Opaque delivery reference
                          <input
                            name="deliveryReference"
                            required
                            pattern="[A-Za-z0-9][A-Za-z0-9._-]*"
                          />
                        </label>
                        <button className="button button--primary" type="submit">
                          Mark export delivered
                        </button>
                      </form>
                    </div>
                  ) : null}
                </>
              )}
            </article>
          ))}
          {page.dataRequests.length === 0 ? (
            <p className="platform-empty">No verified requests matched this filter.</p>
          ) : null}
        </div>
      </section>
    </div>
  );
}
