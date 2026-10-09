import { describe, expect, it } from 'vitest';

import {
  AuthorizationFailure,
  authorise,
  permissions,
  type AppSession,
  type Role
} from './authorise.js';

const sessionFixture = (options: {
  role: Role;
  organisationId?: string;
  disabled?: boolean;
}): AppSession => ({
  userId: 'user-1',
  cognitoSubject: 'cognito-sub-1',
  displayName: 'Alex Operator',
  expiresAt: '2026-09-18T08:00:00.000Z',
  memberships: [
    {
      organisationId: options.organisationId ?? 'org-1',
      role: options.role,
      active: options.disabled !== true
    }
  ]
});

describe('authorise', () => {
  it.each([
    ['ADMIN', 'sequence.set-automatic', true],
    ['OPERATOR', 'sequence.set-automatic', false],
    ['OPERATOR', 'reminder.approve', true],
    ['OPERATOR', 'provider.configure', false],
    ['ADMIN', 'user.manage', true],
    ['OPERATOR', 'chase.operate', true],
    ['ADMIN', 'outbox.read', true],
    ['OPERATOR', 'outbox.read', true],
    ['ADMIN', 'reminder-whitelist.add', true],
    ['OPERATOR', 'reminder-whitelist.add', true],
    ['ADMIN', 'reminder-whitelist.remove', true],
    ['OPERATOR', 'reminder-whitelist.remove', false],
    ['ADMIN', 'message.test-sms', true],
    ['OPERATOR', 'message.test-sms', false],
    ['ADMIN', 'voice-call.read', true],
    ['OPERATOR', 'voice-call.read', true],
    ['ADMIN', 'voice-call.prepare', true],
    ['OPERATOR', 'voice-call.prepare', true],
    ['ADMIN', 'voice-call.place', true],
    ['OPERATOR', 'voice-call.place', true],
    ['ADMIN', 'voice-contact.override', true],
    ['OPERATOR', 'voice-contact.override', true],
    ['ADMIN', 'voice-suppression.clear', true],
    ['OPERATOR', 'voice-suppression.clear', false],
    ['ADMIN', 'voice-settings.manage', true],
    ['OPERATOR', 'voice-settings.manage', false]
  ] as const)('%s permission for %s is %s', (role, action, allowed) => {
    const attempt = () =>
      authorise(sessionFixture({ role }), action, 'org-1');
    if (allowed) expect(attempt).not.toThrow();
    else expect(attempt).toThrow(AuthorizationFailure);
  });

  it('rejects cross-organisation access even for an Admin', () => {
    expect(() =>
      authorise(sessionFixture({ role: 'ADMIN' }), 'audit.read', 'org-2')
    ).toThrow('FORBIDDEN');
  });

  it('rejects a disabled membership', () => {
    expect(() =>
      authorise(
        sessionFixture({ role: 'ADMIN', disabled: true }),
        'user.manage',
        'org-1'
      )
    ).toThrow('FORBIDDEN');
  });

  it('keeps the permission list closed and explicit', () => {
    expect(permissions.ADMIN).toContain('sequence.set-automatic');
    expect(permissions.OPERATOR).not.toContain('sequence.set-automatic');
    expect(permissions.OPERATOR).not.toContain('reminder-whitelist.remove');
    expect(permissions.OPERATOR).not.toContain('message.test-sms');
    expect(permissions.OPERATOR).toContain('voice-contact.override');
    expect(permissions.OPERATOR).not.toContain('voice-suppression.clear');
    expect(permissions.OPERATOR).not.toContain('voice-settings.manage');
  });
});
