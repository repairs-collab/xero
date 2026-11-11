import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { UserAdministrationView } from '../src/app/(protected)/settings/users/user-administration-view.js';

const noAction = (formData: FormData): Promise<void> => {
  void formData;
  return Promise.resolve();
};

describe('UserAdministrationView', () => {
  it('renders invitation controls and member actions with clear statuses', () => {
    const html = renderToStaticMarkup(
      <UserAdministrationView
        organisationId="org-1"
        currentUserId="user-1"
        feedback={{ kind: 'success', message: 'Invitation sent.' }}
        members={[
          {
            userId: 'user-1',
            email: 'admin@example.com',
            displayName: 'Admin User',
            role: 'ADMIN',
            status: 'ACTIVE',
            invitationId: null,
            membershipVersion: 0,
            invitationVersion: null
          },
          {
            userId: 'user-2',
            email: 'operator@example.com',
            displayName: 'New Operator',
            role: 'OPERATOR',
            status: 'INVITED',
            invitationId: 'invite-2',
            membershipVersion: 0,
            invitationVersion: 0
          },
          {
            userId: 'user-3',
            email: 'disabled@example.com',
            displayName: 'Disabled User',
            role: 'OPERATOR',
            status: 'DISABLED',
            invitationId: null,
            membershipVersion: 1,
            invitationVersion: null
          }
        ]}
        inviteAction={noAction}
        resendAction={noAction}
        changeRoleAction={noAction}
        disableAction={noAction}
      />
    );

    expect(html).toContain('Invite a user');
    expect(html).toContain('Invitation sent.');
    expect(html).toContain('New Operator');
    expect(html).toContain('Invited');
    expect(html).toContain('Resend invite');
    expect(html).toContain('Change role');
    expect(html).toContain('Disable access');
    expect(html).toContain('Disabled');
    expect(html).toContain('You');
  });

  it('renders suspended accounts as read-only without mutation controls', () => {
    const html = renderToStaticMarkup(
      <UserAdministrationView
        organisationId="org-1"
        currentUserId="user-1"
        readOnly
        members={[
          {
            userId: 'user-1',
            email: 'admin@example.com',
            displayName: 'Admin User',
            role: 'ADMIN',
            status: 'ACTIVE',
            invitationId: null,
            membershipVersion: 0,
            invitationVersion: null
          }
        ]}
        inviteAction={noAction}
        resendAction={noAction}
        changeRoleAction={noAction}
        disableAction={noAction}
      />
    );

    expect(html).toContain('User management is paused while this account is suspended.');
    expect(html).toContain('Admin User');
    expect(html).not.toContain('Send invitation');
    expect(html).not.toContain('Change role');
    expect(html).not.toContain('Disable access');
  });
});
