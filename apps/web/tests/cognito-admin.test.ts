import {
  AdminCreateUserCommand,
  AdminDisableUserCommand,
  type CognitoIdentityProviderClient
} from '@aws-sdk/client-cognito-identity-provider';
import { describe, expect, it, vi } from 'vitest';

import { AwsCognitoUserAdministration } from '../src/server/cognito-admin.js';

describe('AwsCognitoUserAdministration', () => {
  it('uses the stable Cognito subject when disabling a user', async () => {
    const send = vi.fn((command: unknown) => {
      if (command instanceof AdminCreateUserCommand) {
        return Promise.resolve({
          User: {
            Attributes: [{ Name: 'sub', Value: 'subject-123' }]
          }
        });
      }
      return Promise.resolve({});
    });
    const client = { send } as unknown as CognitoIdentityProviderClient;
    const administration = new AwsCognitoUserAdministration(
      client,
      'pool-1'
    );

    const created = await administration.createUser('person@example.com');
    await administration.disableUser(created.subject);

    const disableCommand = send.mock.calls
      .map(([command]) => command)
      .find((command) => command instanceof AdminDisableUserCommand);
    expect(disableCommand).toBeInstanceOf(AdminDisableUserCommand);
    expect((disableCommand as AdminDisableUserCommand).input).toMatchObject({
      UserPoolId: 'pool-1',
      Username: 'subject-123'
    });
  });
});
