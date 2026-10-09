type Environment = Record<string, string | undefined>;

export interface ManagedSecretReader {
  read(reference: string): Promise<string>;
}

export function createEnvironmentSecretReader(
  environment: Environment
): ManagedSecretReader {
  return {
    read: (reference) => {
      const name = reference.startsWith('env:')
        ? reference.slice('env:'.length)
        : reference;
      if (!/^[A-Z][A-Z0-9_]*$/.test(name)) {
        return Promise.reject(new Error('Secret reference is invalid'));
      }
      const value = environment[name]?.trim();
      if (!value) {
        return Promise.reject(new Error('Managed secret is unavailable'));
      }
      return Promise.resolve(value);
    }
  };
}

export type OperationalResetCommand =
  | {
      kind: 'prepare';
      input: {
        organisationId: string;
        resetRunId: string;
        deployedCommit: string;
        adminEmail: string;
        acknowledgement: string;
        expectedVersion: number;
      };
    }
  | {
      kind: 'execute';
      input: {
        organisationId: string;
        resetRunId: string;
        snapshotIdentifier: string;
      };
    }
  | {
      kind: 'abort';
      input: {
        organisationId: string;
        resetRunId: string;
        adminEmail: string;
        reason: string;
      };
    };

export type ApprovedSmsRecoveryCommand =
  | {
      kind: 'preview';
      input: { organisationId: string; localDate: string };
    }
  | {
      kind: 'execute';
      input: {
        organisationId: string;
        localDate: string;
        expectedCount: number;
        expectedDigest: string;
        acknowledgement: string;
      };
    };

export interface InboundReplyRecoveryCommand {
  organisationId?: string;
}

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

const parseFlags = (arguments_: string[]): Map<string, string> => {
  if (arguments_.length % 2 !== 0) {
    throw new Error('Operational reset flags require values');
  }
  const flags = new Map<string, string>();
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index];
    const value = arguments_[index + 1];
    if (name === undefined || !name.startsWith('--') || value === undefined) {
      throw new Error('Operational reset flags are invalid');
    }
    const key = name.slice(2);
    if (flags.has(key)) throw new Error(`${key} was supplied more than once`);
    flags.set(key, value);
  }
  return flags;
};

const flag = (flags: Map<string, string>, name: string): string => {
  const value = flags.get(name)?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};

export function parseApprovedSmsRecoveryCommand(
  arguments_: string[]
): ApprovedSmsRecoveryCommand | null {
  if (arguments_.length === 0) return null;
  if (arguments_[0] !== 'recover-approved-sms') {
    throw new Error('Unsupported worker command');
  }
  const subcommand = arguments_[1];
  const flags = parseFlags(arguments_.slice(2));
  const organisationId = flag(flags, 'organisation-id');
  const localDate = flag(flags, 'local-date');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(localDate)) {
    throw new Error('local-date is invalid');
  }
  if (subcommand === 'preview') {
    rejectUnknownFlags(flags, ['organisation-id', 'local-date']);
    return { kind: 'preview', input: { organisationId, localDate } };
  }
  if (subcommand === 'execute') {
    rejectUnknownFlags(flags, [
      'organisation-id',
      'local-date',
      'expected-count',
      'expected-digest',
      'acknowledgement'
    ]);
    const expectedCountSource = flag(flags, 'expected-count');
    if (!/^\d+$/.test(expectedCountSource)) {
      throw new Error('expected-count is invalid');
    }
    const expectedCount = Number(expectedCountSource);
    if (!Number.isSafeInteger(expectedCount)) {
      throw new Error('expected-count is invalid');
    }
    const expectedDigest = flag(flags, 'expected-digest').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(expectedDigest)) {
      throw new Error('expected-digest is invalid');
    }
    return {
      kind: 'execute',
      input: {
        organisationId,
        localDate,
        expectedCount,
        expectedDigest,
        acknowledgement: flag(flags, 'acknowledgement')
      }
    };
  }
  throw new Error(
    'Approved SMS recovery subcommand must be preview or execute'
  );
}

const rejectUnknownFlags = (
  flags: Map<string, string>,
  allowed: readonly string[]
): void => {
  for (const name of flags.keys()) {
    if (!allowed.includes(name)) throw new Error(`${name} is not supported`);
  }
};

export function parseInboundReplyRecoveryCommand(
  arguments_: string[]
): InboundReplyRecoveryCommand | null {
  if (arguments_.length === 0) return null;
  if (arguments_[0] !== 'recover-inbound-replies') {
    throw new Error('Unsupported worker command');
  }
  const flags = parseFlags(arguments_.slice(1));
  rejectUnknownFlags(flags, ['organisation-id']);
  const organisationId = flags.get('organisation-id')?.trim();
  return organisationId ? { organisationId } : {};
}

export function parseOperationalResetCommand(
  arguments_: string[]
): OperationalResetCommand | null {
  if (arguments_.length === 0) return null;
  if (arguments_[0] !== 'operational-reset') {
    throw new Error('Unsupported worker command');
  }
  const subcommand = arguments_[1];
  const flags = parseFlags(arguments_.slice(2));
  if (subcommand === 'prepare') {
    rejectUnknownFlags(flags, [
      'organisation-id',
      'run-id',
      'deployed-commit',
      'admin-email',
      'acknowledgement',
      'expected-version'
    ]);
    const expectedVersionSource = flag(flags, 'expected-version');
    if (!/^\d+$/.test(expectedVersionSource)) {
      throw new Error('expected-version is invalid');
    }
    const expectedVersion = Number(expectedVersionSource);
    if (!Number.isSafeInteger(expectedVersion)) {
      throw new Error('expected-version is invalid');
    }
    return {
      kind: 'prepare',
      input: {
        organisationId: flag(flags, 'organisation-id'),
        resetRunId: flag(flags, 'run-id'),
        deployedCommit: flag(flags, 'deployed-commit'),
        adminEmail: flag(flags, 'admin-email'),
        acknowledgement: flag(flags, 'acknowledgement'),
        expectedVersion
      }
    };
  }
  if (subcommand === 'execute') {
    rejectUnknownFlags(flags, ['organisation-id', 'run-id', 'snapshot-id']);
    return {
      kind: 'execute',
      input: {
        organisationId: flag(flags, 'organisation-id'),
        resetRunId: flag(flags, 'run-id'),
        snapshotIdentifier: flag(flags, 'snapshot-id')
      }
    };
  }
  if (subcommand === 'abort') {
    rejectUnknownFlags(flags, [
      'organisation-id',
      'run-id',
      'admin-email',
      'reason'
    ]);
    return {
      kind: 'abort',
      input: {
        organisationId: flag(flags, 'organisation-id'),
        resetRunId: flag(flags, 'run-id'),
        adminEmail: flag(flags, 'admin-email'),
        reason: flag(flags, 'reason')
      }
    };
  }
  throw new Error('Operational reset subcommand must be prepare, execute, or abort');
}
