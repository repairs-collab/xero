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
            invitationId: null
          },
          {
            userId: 'user-2',
            email: 'operator@example.com',
            displayName: 'New Operator',
            role: 'OPERATOR',
            status: 'INVITED',
            invitationId: 'invite-2'
          },
          {
            userId: 'user-3',
            email: 'disabled@example.com',
            displayName: 'Disabled User',
            role: 'OPERATOR',
            status: 'DISABLED',
            invitationId: null
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
});
