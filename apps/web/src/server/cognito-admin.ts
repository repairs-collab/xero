import {
  AdminCreateUserCommand,
  AdminDisableUserCommand,
  CognitoIdentityProviderClient
} from '@aws-sdk/client-cognito-identity-provider';

import type { CognitoUserAdministration } from '../app/(protected)/settings/users/user-administration.js';

export class AwsCognitoUserAdministration
  implements CognitoUserAdministration
{
  constructor(
    private readonly client: CognitoIdentityProviderClient,
    private readonly userPoolId: string
  ) {}

  async createUser(email: string): Promise<{ subject: string }> {
    const response = await this.client.send(
      new AdminCreateUserCommand({
        UserPoolId: this.userPoolId,
        Username: email,
        UserAttributes: [
          { Name: 'email', Value: email },
          { Name: 'email_verified', Value: 'true' }
        ],
        DesiredDeliveryMediums: ['EMAIL']
      })
    );
    const subject = response.User?.Attributes?.find(
      (attribute) => attribute.Name === 'sub'
    )?.Value;
    if (subject === undefined) {
      throw new Error('Cognito created no user subject');
    }
    return { subject };
  }

  async resendInvitation(email: string): Promise<void> {
    await this.client.send(
      new AdminCreateUserCommand({
        UserPoolId: this.userPoolId,
        Username: email,
        MessageAction: 'RESEND',
        DesiredDeliveryMediums: ['EMAIL']
      })
    );
  }

  async disableUser(subject: string): Promise<void> {
    await this.client.send(
      new AdminDisableUserCommand({
        UserPoolId: this.userPoolId,
        Username: subject
      })
    );
  }
}

export const createAwsCognitoUserAdministration = () => {
  const userPoolId = process.env.COGNITO_USER_POOL_ID;
  if (userPoolId === undefined) {
    throw new Error('COGNITO_USER_POOL_ID is required');
  }
  return new AwsCognitoUserAdministration(
    new CognitoIdentityProviderClient({
      region: process.env.AWS_REGION ?? 'ap-southeast-2'
    }),
    userPoolId
  );
};
