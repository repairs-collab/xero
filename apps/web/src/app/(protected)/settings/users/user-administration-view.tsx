import type { UserAdministrationMember } from './user-administration.js';

type UserAction = (formData: FormData) => Promise<void>;

export interface UserAdministrationFeedback {
  kind: 'success' | 'error';
  message: string;
}

const statusLabel = {
  INVITED: 'Invited',
  ACTIVE: 'Active',
  DISABLED: 'Disabled'
} as const;

export function UserAdministrationView({
  organisationId,
  currentUserId,
  members,
  feedback,
  inviteAction,
  resendAction,
  changeRoleAction,
  disableAction
}: {
  organisationId: string;
  currentUserId: string;
  members: UserAdministrationMember[];
  feedback?: UserAdministrationFeedback;
  inviteAction: UserAction;
  resendAction: UserAction;
  changeRoleAction: UserAction;
  disableAction: UserAction;
}) {
  return (
    <div className="page-stack">
      <header className="page-heading">
        <span className="eyebrow">Access control</span>
        <h1>Users</h1>
        <p>Invite and manage AccountPulse administrators and operators.</p>
      </header>

      {feedback === undefined ? null : (
        <div
          className={`user-feedback user-feedback--${feedback.kind}`}
          role={feedback.kind === 'error' ? 'alert' : 'status'}
        >
          {feedback.message}
        </div>
      )}

      <section className="panel user-invite-panel">
        <div>
          <span className="eyebrow">New account</span>
          <h2>Invite a user</h2>
          <p>
            They will receive an email from AccountPulse with a temporary
            password and sign-in instructions.
          </p>
        </div>
        <form action={inviteAction} className="user-invite-form">
          <input type="hidden" name="organisationId" value={organisationId} />
          <label>
            Name
            <input name="displayName" type="text" autoComplete="name" required />
          </label>
          <label>
            Email
            <input name="email" type="email" autoComplete="email" required />
          </label>
          <label>
            Access level
            <select name="role" defaultValue="OPERATOR">
              <option value="OPERATOR">Operator</option>
              <option value="ADMIN">Administrator</option>
            </select>
          </label>
          <button className="button button--primary" type="submit">
            Send invitation
          </button>
        </form>
      </section>

      <section className="panel user-list-panel">
        <div className="user-list-heading">
          <div>
            <span className="eyebrow">Team access</span>
            <h2>{members.length} {members.length === 1 ? 'user' : 'users'}</h2>
          </div>
          <p>Administrators can manage users and settings. Operators can chase accounts.</p>
        </div>
        <div className="user-list">
          {members.map((member) => (
            <article className="user-row" key={member.userId}>
              <div className="user-row__identity">
                <span className="avatar">
                  {member.displayName.slice(0, 2).toUpperCase()}
                </span>
                <div>
                  <h3>
                    {member.displayName}{' '}
                    {member.userId === currentUserId ? (
                      <span className="user-you">You</span>
                    ) : null}
                  </h3>
                  <p>{member.email}</p>
                </div>
              </div>
              <div className="user-row__state">
                <span className={`user-status user-status--${member.status.toLowerCase()}`}>
                  {statusLabel[member.status]}
                </span>
                <span className="user-role">
                  {member.role === 'ADMIN' ? 'Administrator' : 'Operator'}
                </span>
              </div>
              <div className="user-row__actions">
                {member.status === 'INVITED' && member.invitationId !== null ? (
                  <form action={resendAction}>
                    <input type="hidden" name="organisationId" value={organisationId} />
                    <input type="hidden" name="invitationId" value={member.invitationId} />
                    <button className="button button--quiet" type="submit">
                      Resend invite
                    </button>
                  </form>
                ) : null}
                {member.status !== 'DISABLED' ? (
                  <form action={changeRoleAction} className="user-role-form">
                    <input type="hidden" name="organisationId" value={organisationId} />
                    <input type="hidden" name="userId" value={member.userId} />
                    <select name="role" defaultValue={member.role} aria-label={`Access level for ${member.displayName}`}>
                      <option value="OPERATOR">Operator</option>
                      <option value="ADMIN">Administrator</option>
                    </select>
                    <button className="button button--quiet" type="submit">
                      Change role
                    </button>
                  </form>
                ) : null}
                {member.status !== 'DISABLED' ? (
                  <form action={disableAction}>
                    <input type="hidden" name="organisationId" value={organisationId} />
                    <input type="hidden" name="userId" value={member.userId} />
                    <button
                      className="button button--danger"
                      type="submit"
                      disabled={member.userId === currentUserId}
                      title={member.userId === currentUserId ? 'You cannot disable your own account here.' : undefined}
                    >
                      Disable access
                    </button>
                  </form>
                ) : null}
              </div>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}
