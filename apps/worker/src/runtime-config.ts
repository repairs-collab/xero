type Environment = Record<string, string | undefined>;

const required = (environment: Environment, name: string): string => {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const field = (
  value: Record<string, unknown>,
  name: string,
  secretName: string
): string => {
  const candidate = value[name];
  if (typeof candidate !== 'string' || candidate.trim() === '') {
    throw new Error(`${secretName}.${name} is required`);
  }
  return candidate;
};

const parseObject = (source: string, name: string): Record<string, unknown> => {
  const value = JSON.parse(source) as unknown;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${name} must contain a JSON object`);
  }
  return value as Record<string, unknown>;
};

export function databaseUrlFromEnvironment(environment: Environment): string {
  if (environment.DATABASE_URL) return environment.DATABASE_URL;
  const host = required(environment, 'DATABASE_HOST');
  const port = required(environment, 'DATABASE_PORT');
  const name = required(environment, 'DATABASE_NAME');
  const user = required(environment, 'DATABASE_USER');
  const password = required(environment, 'DATABASE_PASSWORD');
  if (!/^\d{1,5}$/.test(port)) throw new Error('DATABASE_PORT is invalid');
  if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error('DATABASE_NAME is invalid');
  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${name}`;
}

export function parseProviderCredentials(environment: Environment) {
  const xero = parseObject(
    required(environment, 'XERO_API_CREDENTIALS'),
    'XERO_API_CREDENTIALS'
  );
  const sinch = parseObject(
    required(environment, 'SINCH_API_CREDENTIALS'),
    'SINCH_API_CREDENTIALS'
  );
  return {
    xero: {
      clientId: field(xero, 'clientId', 'XERO_API_CREDENTIALS'),
      clientSecret: field(xero, 'clientSecret', 'XERO_API_CREDENTIALS')
    },
    sinch: {
      apiKey: field(sinch, 'apiKey', 'SINCH_API_CREDENTIALS'),
      apiSecret: field(sinch, 'apiSecret', 'SINCH_API_CREDENTIALS')
    }
  };
}
