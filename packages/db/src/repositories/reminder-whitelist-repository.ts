import { and, eq, isNull, or } from 'drizzle-orm';

import type { Database, DbTransaction } from '../client.js';
import { contacts, invoices } from '../schema/receivables.js';
import {
  reminderWhitelistEntries,
  type ReminderWhitelistScope
} from '../schema/reminder-whitelist.js';

export interface ReminderWhitelistTarget {
  organisationId: string;
  contactId: string;
  invoiceId?: string;
}

type Executor = Database | DbTransaction;

export class PostgresReminderWhitelistRepository {
  constructor(private readonly database: Database) {}

  async lockTarget(
    transaction: DbTransaction,
    input: ReminderWhitelistTarget
  ): Promise<void> {
    const [contact] = await transaction
      .select({ id: contacts.id })
      .from(contacts)
      .where(
        and(
          eq(contacts.organisationId, input.organisationId),
          eq(contacts.id, input.contactId)
        )
      )
      .for('update')
      .limit(1);
    if (contact === undefined) throw new Error('REMINDER_WHITELIST_TARGET_NOT_FOUND');
    if (input.invoiceId === undefined) return;
    const [invoice] = await transaction
      .select({ id: invoices.id })
      .from(invoices)
      .where(
        and(
          eq(invoices.organisationId, input.organisationId),
          eq(invoices.contactId, input.contactId),
          eq(invoices.id, input.invoiceId)
        )
      )
      .for('update')
      .limit(1);
    if (invoice === undefined) throw new Error('REMINDER_WHITELIST_TARGET_NOT_FOUND');
  }

  async findActive(
    input: ReminderWhitelistTarget,
    executor: Executor = this.database
  ) {
    return executor
      .select()
      .from(reminderWhitelistEntries)
      .where(
        and(
          eq(reminderWhitelistEntries.organisationId, input.organisationId),
          isNull(reminderWhitelistEntries.removedAt),
          or(
            and(
              eq(reminderWhitelistEntries.scope, 'CLIENT'),
              eq(reminderWhitelistEntries.contactId, input.contactId)
            ),
            input.invoiceId === undefined
              ? undefined
              : and(
                  eq(reminderWhitelistEntries.scope, 'INVOICE'),
                  eq(reminderWhitelistEntries.invoiceId, input.invoiceId)
                )
          )
        )
      );
  }

  async add(
    transaction: DbTransaction,
    input: ReminderWhitelistTarget & {
      scope: ReminderWhitelistScope;
      reason?: string;
      actorUserId: string;
      now: Date;
    }
  ) {
    const active = await this.findActive(input, transaction);
    const matching = active.find((entry) => entry.scope === input.scope);
    if (matching !== undefined) return { entry: matching, created: false };
    const [entry] = await transaction
      .insert(reminderWhitelistEntries)
      .values({
        organisationId: input.organisationId,
        scope: input.scope,
        contactId: input.contactId,
        invoiceId: input.scope === 'INVOICE' ? input.invoiceId : null,
        reason: input.reason,
        createdByUserId: input.actorUserId,
        createdAt: input.now
      })
      .returning();
    if (entry === undefined) throw new Error('REMINDER_WHITELIST_CREATE_FAILED');
    return { entry, created: true };
  }

  async remove(
    transaction: DbTransaction,
    input: {
      organisationId: string;
      entryId: string;
      actorUserId: string;
      now: Date;
    }
  ) {
    const [entry] = await transaction
      .update(reminderWhitelistEntries)
      .set({ removedByUserId: input.actorUserId, removedAt: input.now })
      .where(
        and(
          eq(reminderWhitelistEntries.organisationId, input.organisationId),
          eq(reminderWhitelistEntries.id, input.entryId),
          isNull(reminderWhitelistEntries.removedAt)
        )
      )
      .returning();
    return entry ?? null;
  }
}
