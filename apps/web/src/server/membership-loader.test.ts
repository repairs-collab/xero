import { describe, expect, it } from 'vitest';

import { membershipSnapshotFromRows } from './membership-loader.js';

describe('membershipSnapshotFromRows', () => {
  it('carries organisation suspension state into every customer session membership', () => {
    expect(
      membershipSnapshotFromRows([
        {
          user: {
            id: 'user-1',
            displayName: 'Customer Admin',
            disabledAt: null
          },
          membership: {
            organisationId: 'organisation-1',
            role: 'ADMIN',
            disabledAt: null
          },
          organisationStatus: 'SUSPENDED'
        }
      ])
    ).toEqual({
      userId: 'user-1',
      displayName: 'Customer Admin',
      active: true,
      memberships: [
        {
          organisationId: 'organisation-1',
          role: 'ADMIN',
          active: true,
          organisationStatus: 'SUSPENDED'
        }
      ]
    });
  });
});
