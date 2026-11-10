import type { HttpClient } from '@bc5000/integrations/http';
import {
  LegacyXeroSessionProvider,
  XeroClient,
  XeroOAuthSessionProvider,
  type TokenCipher,
  type XeroOAuthClient,
  type XeroRefreshTokenStore,
  type XeroTokenProvider
} from '@bc5000/integrations/xero';

export interface OrganisationXeroClientFactoryOptions {
  http: HttpClient;
  connectionStore: XeroRefreshTokenStore;
  tokenCipher: TokenCipher;
  oauthClient: Pick<XeroOAuthClient, 'refreshAccessToken'>;
  legacyConnectionEnabled(organisationId: string): Promise<boolean>;
  legacyTokenProvider?: XeroTokenProvider;
}

export class OrganisationXeroClientFactory {
  constructor(
    private readonly options: OrganisationXeroClientFactoryOptions
  ) {}

  async forOrganisation(organisationId: string): Promise<XeroClient> {
    const connection = await this.options.connectionStore.findByOrganisationId(
      organisationId
    );
    if (connection !== null && connection.status !== 'DISCONNECTED') {
      return new XeroClient({
        http: this.options.http,
        sessionProvider: new XeroOAuthSessionProvider({
          organisationId,
          store: this.options.connectionStore,
          tokenCipher: this.options.tokenCipher,
          oauthClient: this.options.oauthClient
        })
      });
    }

    if (!(await this.options.legacyConnectionEnabled(organisationId))) {
      throw new Error('XERO_CONNECTION_REQUIRED');
    }
    if (this.options.legacyTokenProvider === undefined) {
      throw new Error('XERO_LEGACY_CREDENTIALS_REQUIRED');
    }
    return new XeroClient({
      http: this.options.http,
      sessionProvider: new LegacyXeroSessionProvider(
        this.options.legacyTokenProvider
      )
    });
  }
}
