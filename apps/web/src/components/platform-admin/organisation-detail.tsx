import Link from 'next/link';

import type { PlatformOrganisationDetail } from '@bc5000/db/web';

type FormAction = (formData: FormData) => Promise<unknown>;

export interface PlatformOrganisationActions {
  extendTrial: FormAction;
  endTrial: FormAction;
  suspend: FormAction;
  reactivate: FormAction;
  updateAllowance: FormAction;
  inviteUser: FormAction;
  resendInvitation: FormAction;
  changeRole: FormAction;
  disableUser: FormAction;
}

const dateTime = (value: Date | null): string =>
  value
    ? new Intl.DateTimeFormat('en-AU', {
        dateStyle: 'medium',
        timeStyle: 'short'
      }).format(value)
    : '—';

const number = (value: number): string =>
  new Intl.NumberFormat('en-AU').format(value);

const Confirm = ({ copy }: { copy: string }) => (
  <label className="platform-confirm">
    <input type="checkbox" name="confirmation" value="confirmed" required />
    <span>{copy}</span>
  </label>
);

const feedback = (code: string | undefined) => {
  switch (code) {
    case 'UPDATED':
      return { kind: 'success', title: 'Change saved', copy: 'The customer account is up to date.' };
    case 'CONFLICT':
      return { kind: 'warning', title: 'The record changed', copy: 'Refresh this page and review the latest values before trying again.' };
    case 'BILLING_RISK_HOLD':
      return { kind: 'warning', title: 'Financial review required', copy: 'resolve the open payment or dispute case before reactivating this account.' };
    case 'LAST_ADMIN_REQUIRED':
      return { kind: 'warning', title: 'Administrator required', copy: 'At least one active customer administrator must remain.' };
    case 'INVALID_STATE':
      return { kind: 'warning', title: 'Change not available', copy: 'The account is no longer in the state required for this action.' };
    case 'VALIDATION':
      return { kind: 'warning', title: 'Check the details', copy: 'One or more submitted values were invalid.' };
    case 'FAILED':
      return { kind: 'warning', title: 'Change failed', copy: 'The change was not completed. Review the account and try again.' };
    default:
      return null;
  }
};

export function PlatformOrganisationDetailView({
  detail,
  actions,
  feedbackCode
}: {
  detail: PlatformOrganisationDetail;
  actions: PlatformOrganisationActions;
  feedbackCode?: string;
}) {
  const smsUsed = detail.smsUsage.committedParts + detail.smsUsage.reservedParts;
  const expectedUpdatedAt = detail.subscription?.updatedAt.toISOString() ?? '';
  const notice = feedback(feedbackCode);
  return (
    <div className="platform-page-stack">
      <header className="platform-page-heading">
        <div>
          <Link href="/platform-admin" className="back-link">← All customers</Link>
          <span className="eyebrow">Customer account</span>
          <h1>{detail.name}</h1>
          <p>{detail.xeroOrganisationId}</p>
        </div>
        <div className="platform-heading-links">
          <a
            className="button button--quiet"
            href={`/platform-admin/organisations/${encodeURIComponent(detail.id)}/backup`}
          >
            Download backup
          </a>
          <span className={`platform-status platform-status--${detail.platformStatus.toLowerCase()}`}>
            {detail.platformStatus}
          </span>
        </div>
      </header>

      {notice ? (
        <div className={`platform-feedback platform-feedback--${notice.kind}`} role={notice.kind === 'success' ? 'status' : 'alert'}>
          <strong>{notice.title}</strong>
          <span>{notice.copy}</span>
        </div>
      ) : null}

      <section className="platform-fact-grid">
        <article className="panel"><span>Subscription</span><strong>{detail.subscription?.status ?? 'None'}</strong><small>{detail.subscription?.planCode ?? '—'} · trial ends {dateTime(detail.subscription?.trialEndsAt ?? null)}</small></article>
        <article className="panel"><span>Xero</span><strong>{detail.xero?.status ?? 'Not connected'}</strong><small>{detail.xero?.tenantId ?? '—'}</small></article>
        <article className="panel"><span>Reply number</span><strong>{detail.smsNumber?.e164Number ?? 'Not assigned'}</strong><small>{detail.smsNumber?.status ?? '—'} · {detail.smsNumber?.providerNumberId ?? 'No provider ID'}</small></article>
        <article className="panel"><span>SMS allowance</span><strong>{number(smsUsed)} of {number(detail.smsUsage.includedParts)} parts</strong><small>Warning at {detail.smsUsage.warningPercent}%</small></article>
        <article className="panel"><span>Last Xero sync</span><strong>{dateTime(detail.lastSuccessfulSyncAt)}</strong><small>{detail.timeZone}</small></article>
        <article className="panel"><span>Onboarding</span><strong>{detail.onboarding?.completedVersion === detail.onboarding?.version ? 'Complete' : 'Incomplete'}</strong><small>Reply ready {dateTime(detail.onboarding?.replyNumberReadyAt ?? null)}</small></article>
      </section>

      <section className="platform-admin-grid">
        <article className="panel platform-control-card">
          <h2>Trial and account status</h2>
          {detail.subscription?.status === 'TRIALING' ? (
            <>
              <form action={actions.extendTrial as never}>
                <input type="hidden" name="organisationId" value={detail.id} />
                <input type="hidden" name="expectedUpdatedAt" value={expectedUpdatedAt} />
                <label>New trial end<input type="datetime-local" name="newEnd" required /></label>
                <label>Reason<textarea name="reason" required /></label>
                <Confirm copy="I have confirmed this trial extension." />
                <button className="button button--primary" type="submit">Extend trial</button>
              </form>
              <form action={actions.endTrial as never}>
                <input type="hidden" name="organisationId" value={detail.id} />
                <input type="hidden" name="expectedUpdatedAt" value={expectedUpdatedAt} />
                <label>Reason<textarea name="reason" required /></label>
                <Confirm copy="I understand this ends the trial immediately." />
                <button className="button button--danger" type="submit">End trial now</button>
              </form>
            </>
          ) : <p>No active trial controls for this subscription.</p>}
          <form action={(detail.platformStatus === 'ACTIVE' ? actions.suspend : actions.reactivate) as never}>
            <input type="hidden" name="organisationId" value={detail.id} />
            <input type="hidden" name="expectedVersion" value={detail.platformStatusVersion} />
            <label>Reason<textarea name="reason" required /></label>
            <Confirm copy={detail.platformStatus === 'ACTIVE' ? 'I understand all customer sending will stop.' : 'I have confirmed this account may resume operations.'} />
            <button className={`button ${detail.platformStatus === 'ACTIVE' ? 'button--danger' : 'button--primary'}`} type="submit">
              {detail.platformStatus === 'ACTIVE' ? 'Suspend account' : 'Reactivate account'}
            </button>
          </form>
        </article>

        <article className="panel platform-control-card">
          <h2>SMS allowance</h2>
          <form action={actions.updateAllowance as never}>
            <input type="hidden" name="organisationId" value={detail.id} />
            <input type="hidden" name="expectedUpdatedAt" value={detail.smsUsage.allowanceUpdatedAt?.toISOString() ?? ''} />
            <label>Included SMS parts<input type="number" name="includedParts" min="1" max="1000000" defaultValue={detail.smsUsage.includedParts} required /></label>
            <label>Warning percent<input type="number" name="warningPercent" min="1" max="100" defaultValue={detail.smsUsage.warningPercent} required /></label>
            <label>Reason<textarea name="reason" required /></label>
            <Confirm copy="I have confirmed the customer plan and allowance." />
            <button className="button button--primary" type="submit">Update allowance</button>
          </form>
        </article>
      </section>

      <section className="panel platform-user-management">
        <div className="panel__heading"><div><span className="eyebrow">Access</span><h2>Customer users</h2></div><span>{detail.users.length} users</span></div>
        <form action={actions.inviteUser as never} className="platform-inline-form">
          <input type="hidden" name="organisationId" value={detail.id} />
          <label>Name<input name="displayName" required /></label>
          <label>Email<input name="email" type="email" required /></label>
          <label>Role<select name="role" defaultValue="OPERATOR"><option value="OPERATOR">Operator</option><option value="ADMIN">Administrator</option></select></label>
          <label>Reason<input name="reason" required /></label>
          <button className="button button--primary" type="submit">Invite user</button>
        </form>
        <div className="platform-user-list">
          {detail.users.map((user) => {
            const disabled = user.userDisabledAt !== null || user.membershipDisabledAt !== null;
            return (
              <article key={user.id}>
                <div><strong>{user.displayName}</strong><span>{user.email}</span></div>
                <span>{disabled ? 'Disabled' : user.role}</span>
                {!disabled ? (
                  <>
                    <form action={actions.changeRole as never}>
                      <input type="hidden" name="organisationId" value={detail.id} />
                      <input type="hidden" name="userId" value={user.id} />
                      <input type="hidden" name="expectedVersion" value={user.membershipVersion} />
                      <select name="role" defaultValue={user.role}><option value="OPERATOR">Operator</option><option value="ADMIN">Administrator</option></select>
                      <input name="reason" aria-label={`Reason to change ${user.displayName}`} placeholder="Reason" required />
                      <button className="button button--quiet" type="submit">Change role</button>
                    </form>
                    <form action={actions.disableUser as never}>
                      <input type="hidden" name="organisationId" value={detail.id} />
                      <input type="hidden" name="userId" value={user.id} />
                      <input type="hidden" name="expectedVersion" value={user.membershipVersion} />
                      <input name="reason" aria-label={`Reason to disable ${user.displayName}`} placeholder="Reason" required />
                      <Confirm copy="Confirm disable" />
                      <button className="button button--danger" type="submit">Disable</button>
                    </form>
                  </>
                ) : null}
              </article>
            );
          })}
        </div>
        {detail.invitations.filter((invite) => invite.status === 'PENDING').map((invite) => (
          <form action={actions.resendInvitation as never} className="platform-pending-invite" key={invite.id}>
            <input type="hidden" name="organisationId" value={detail.id} />
            <input type="hidden" name="invitationId" value={invite.id} />
            <input type="hidden" name="expectedVersion" value={invite.version} />
            <span>{invite.email} · pending until {dateTime(invite.expiresAt)}</span>
            <input name="reason" aria-label={`Reason to resend ${invite.email}`} placeholder="Reason" required />
            <button className="button button--quiet" type="submit">Resend invitation</button>
          </form>
        ))}
      </section>
    </div>
  );
}
