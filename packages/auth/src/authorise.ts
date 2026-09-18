export const permissions = {
  ADMIN: [
    'user.manage',
    'provider.configure',
    'sequence.manage',
    'sequence.set-automatic',
    'reminder.approve',
    'chase.operate',
    'audit.read'
  ],
  OPERATOR: ['reminder.approve', 'chase.operate', 'audit.read']
} as const;

export type Role = keyof typeof permissions;
export type Action = (typeof permissions)[Role][number];

export interface SessionMembership {
  organisationId: string;
  role: Role;
  active: boolean;
}

export interface AppSession {
  userId: string;
  cognitoSubject: string;
  displayName: string;
  expiresAt: string;
  memberships: SessionMembership[];
}

export class AuthorizationFailure extends Error {
  readonly code = 'FORBIDDEN';

  constructor() {
    super('FORBIDDEN');
    this.name = 'AuthorizationFailure';
  }
}

export function authorise(
  session: AppSession,
  action: Action,
  organisationId: string
): SessionMembership {
  const membership = session.memberships.find(
    (candidate) =>
      candidate.organisationId === organisationId && candidate.active
  );
  if (
    membership === undefined ||
    !(permissions[membership.role] as readonly Action[]).includes(action)
  ) {
    throw new AuthorizationFailure();
  }
  return membership;
}
