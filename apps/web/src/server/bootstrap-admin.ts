import { randomUUID } from 'node:crypto';

import { and, eq, isNull } from 'drizzle-orm';

import {
  auditEvents,
  type Database,
  memberships,
  organisations,
  users
} from '@bc5000/db/web';

export interface BootstrapCognitoAdministration {
  createUser(email: string): Promise<{ subject: string }>;
  disableUser(subject: string): Promise<void>;
}

export interface BootstrapFirstAdminDependencies {
  database: Database;
  cognito: BootstrapCognitoAdministration;
  clock: { now(): Date };
}

export interface BootstrapFirstAdminInput {
  email: string;
  displayName: string;
  organisationName: string;
  xeroOrganisationId: string;
  timeZone: string;
  baseCurrency: string;
}

export interface BootstrapFirstAdminResult {
  organisationId: string;
  userId: string;
  created: boolean;
}

export class BootstrapAlreadyCompleted extends Error {
  readonly code = 'BOOTSTRAP_ALREADY_COMPLETED';

  constructor() {
    super('BOOTSTRAP_ALREADY_COMPLETED');
    this.name = 'BootstrapAlreadyCompleted';
  }
}

const requiredText = (value: string, field: string): string => {
  const normalised = value.trim();
  if (normalised.length === 0) throw new Error(`${field} is required`);
  return normalised;
};

const normaliseInput = (
  input: BootstrapFirstAdminInput
): BootstrapFirstAdminInput => {
  const email = requiredText(input.email, 'email').toLowerCase();
  if (!email.includes('@')) throw new Error('email is invalid');
  const xeroOrganisationId = requiredText(
    input.xeroOrganisationId,
    'xeroOrganisationId'
  );
  if (xeroOrganisationId.length > 64) {
    throw new Error('xeroOrganisationId is too long');
  }
  const timeZone = requiredText(input.timeZone, 'timeZone');
  try {
    new Intl.DateTimeFormat('en-AU', { timeZone }).format();
  } catch {
    throw new Error('timeZone is invalid');
  }
  const baseCurrency = requiredText(
    input.baseCurrency,
    'baseCurrency'
  ).toUpperCase();
  if (!/^[A-Z]{3}$/.test(baseCurrency)) {
    throw new Error('baseCurrency must be a three-letter currency code');
  }
  return {
    email,
    displayName: requiredText(input.displayName, 'displayName'),
    organisationName: requiredText(
      input.organisationName,
      'organisationName'
    ),
    xeroOrganisationId,
    timeZone,
    baseCurrency
  };
};

export async function bootstrapFirstAdmin(
  dependencies: BootstrapFirstAdminDependencies,
  rawInput: BootstrapFirstAdminInput
): Promise<BootstrapFirstAdminResult> {
  const input = normaliseInput(rawInput);
  const [existingOrganisation] = await dependencies.database
    .select({ id: organisations.id })
    .from(organisations)
    .where(eq(organisations.xeroOrganisationId, input.xeroOrganisationId))
    .limit(1);

  if (existingOrganisation !== undefined) {
    const [existingAdmin] = await dependencies.database
      .select({ userId: users.id, email: users.email })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(
        and(
          eq(memberships.organisationId, existingOrganisation.id),
          eq(memberships.role, 'ADMIN'),
          isNull(memberships.disabledAt),
          isNull(users.disabledAt)
        )
      )
      .limit(1);
    if (existingAdmin !== undefined) {
      if (existingAdmin.email.toLowerCase() !== input.email) {
        throw new BootstrapAlreadyCompleted();
      }
      return {
        organisationId: existingOrganisation.id,
        userId: existingAdmin.userId,
        created: false
      };
    }
  }

  const [existingUser] = await dependencies.database
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, input.email))
    .limit(1);
  if (existingUser !== undefined) {
    throw new Error('BOOTSTRAP_EMAIL_ALREADY_EXISTS');
  }

  const createdCognitoUser = await dependencies.cognito.createUser(input.email);
  const organisationId = existingOrganisation?.id ?? randomUUID();
  const userId = randomUUID();
  const now = dependencies.clock.now();
  try {
    await dependencies.database.transaction(async (transaction) => {
      if (existingOrganisation === undefined) {
        await transaction.insert(organisations).values({
          id: organisationId,
          xeroOrganisationId: input.xeroOrganisationId,
          name: input.organisationName,
          timeZone: input.timeZone,
          baseCurrency: input.baseCurrency,
          sendMode: 'dry-run',
          liveSendAcknowledged: false,
          recipientAllowlist: [],
          createdAt: now,
          updatedAt: now
        });
      }
      await transaction.insert(users).values({
        id: userId,
        cognitoSubject: createdCognitoUser.subject,
        email: input.email,
        displayName: input.displayName,
        createdAt: now
      });
      await transaction.insert(memberships).values({
        organisationId,
        userId,
        role: 'ADMIN',
        createdAt: now
      });
      await transaction.insert(auditEvents).values({
        organisationId,
        actorUserId: userId,
        eventType: 'INITIAL_ADMIN_BOOTSTRAPPED',
        entityType: 'USER',
        entityId: userId,
        afterValue: { email: input.email, role: 'ADMIN' },
        occurredAt: now
      });
    });
  } catch (error) {
    await dependencies.cognito
      .disableUser(createdCognitoUser.subject)
      .catch(() => undefined);
    throw error;
  }
  return { organisationId, userId, created: true };
}
