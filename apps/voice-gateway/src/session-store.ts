import {
  voiceGatewaySessions,
  type Database,
  type VoiceGatewaySessionState
} from '@bc5000/db';
import { and, eq, inArray } from 'drizzle-orm';

import {
  advanceGatewayCall,
  type GatewayCallEvent
} from './call-state.js';

export interface GatewaySessionRecord {
  gatewayCallId: string;
  organisationId: string;
  voiceCallId: string;
  providerUserNumber: string;
  idempotencyKey: string;
  commandHash: string;
  state: VoiceGatewaySessionState;
  lastEventSequence: number;
  safeFailureCode: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateGatewaySessionInput {
  gatewayCallId: string;
  organisationId: string;
  voiceCallId: string;
  providerUserNumber: string;
  idempotencyKey: string;
  commandHash: string;
  now: Date;
}

export type CreateGatewaySessionResult =
  | { kind: 'created'; session: GatewaySessionRecord }
  | { kind: 'existing'; session: GatewaySessionRecord }
  | { kind: 'conflict'; code: 'GATEWAY_COMMAND_CONFLICT' | 'GATEWAY_USER_BUSY' };

export interface GatewaySessionStore {
  createOrGet(
    input: CreateGatewaySessionInput
  ): Promise<CreateGatewaySessionResult>;
  findByGatewayCallId(
    gatewayCallId: string
  ): Promise<GatewaySessionRecord | null>;
  applyEvent(event: GatewayCallEvent, now: Date): Promise<GatewaySessionRecord | null>;
}

const activeStates: VoiceGatewaySessionState[] = [
  'PENDING',
  'PROVIDER_REQUESTED',
  'GATEWAY_LEG_ANSWERED',
  'CUSTOMER_RINGING',
  'CUSTOMER_ANSWERED',
  'IN_PROGRESS',
  'UNKNOWN'
];

const commandMatches = (
  session: GatewaySessionRecord,
  input: CreateGatewaySessionInput
): boolean =>
  session.gatewayCallId === input.gatewayCallId &&
  session.organisationId === input.organisationId &&
  session.voiceCallId === input.voiceCallId &&
  session.providerUserNumber === input.providerUserNumber &&
  session.idempotencyKey === input.idempotencyKey &&
  session.commandHash === input.commandHash;

export class InMemoryGatewaySessionStore implements GatewaySessionStore {
  private readonly sessions = new Map<string, GatewaySessionRecord>();

  createOrGet(
    input: CreateGatewaySessionInput
  ): Promise<CreateGatewaySessionResult> {
    const idempotent = [...this.sessions.values()].find(
      (session) =>
        session.organisationId === input.organisationId &&
        session.idempotencyKey === input.idempotencyKey
    );
    if (idempotent !== undefined) {
      return Promise.resolve(
        commandMatches(idempotent, input)
          ? { kind: 'existing', session: idempotent }
          : { kind: 'conflict', code: 'GATEWAY_COMMAND_CONFLICT' }
      );
    }
    const sameCall = [...this.sessions.values()].find(
      (session) =>
        session.gatewayCallId === input.gatewayCallId ||
        (session.organisationId === input.organisationId &&
          session.voiceCallId === input.voiceCallId)
    );
    if (sameCall !== undefined) {
      return Promise.resolve({
        kind: 'conflict',
        code: 'GATEWAY_COMMAND_CONFLICT'
      });
    }
    const busy = [...this.sessions.values()].some(
      (session) =>
        session.organisationId === input.organisationId &&
        session.providerUserNumber === input.providerUserNumber &&
        activeStates.includes(session.state)
    );
    if (busy) {
      return Promise.resolve({ kind: 'conflict', code: 'GATEWAY_USER_BUSY' });
    }
    const session: GatewaySessionRecord = {
      gatewayCallId: input.gatewayCallId,
      organisationId: input.organisationId,
      voiceCallId: input.voiceCallId,
      providerUserNumber: input.providerUserNumber,
      idempotencyKey: input.idempotencyKey,
      commandHash: input.commandHash,
      state: 'PENDING',
      lastEventSequence: 0,
      safeFailureCode: null,
      createdAt: input.now,
      updatedAt: input.now
    };
    this.sessions.set(session.gatewayCallId, session);
    return Promise.resolve({ kind: 'created', session });
  }

  findByGatewayCallId(gatewayCallId: string): Promise<GatewaySessionRecord | null> {
    return Promise.resolve(this.sessions.get(gatewayCallId) ?? null);
  }

  async applyEvent(
    event: GatewayCallEvent,
    now: Date
  ): Promise<GatewaySessionRecord | null> {
    const current = this.sessions.get(event.gatewayCallId);
    if (current === undefined) return null;
    const next = advanceGatewayCall(current, event);
    if (next === current) return current;
    const updated = { ...current, ...next, updatedAt: now };
    this.sessions.set(event.gatewayCallId, updated);
    return updated;
  }
}

export class PostgresGatewaySessionStore implements GatewaySessionStore {
  constructor(private readonly database: Database) {}

  async createOrGet(
    input: CreateGatewaySessionInput
  ): Promise<CreateGatewaySessionResult> {
    const inserted = await this.database
      .insert(voiceGatewaySessions)
      .values({
        gatewayCallId: input.gatewayCallId,
        organisationId: input.organisationId,
        voiceCallId: input.voiceCallId,
        providerUserNumber: input.providerUserNumber,
        idempotencyKey: input.idempotencyKey,
        commandHash: input.commandHash,
        state: 'PENDING',
        lastEventSequence: 0,
        createdAt: input.now,
        updatedAt: input.now
      })
      .onConflictDoNothing()
      .returning();
    if (inserted[0] !== undefined) {
      return { kind: 'created', session: inserted[0] };
    }

    const byIdempotency = await this.database
      .select()
      .from(voiceGatewaySessions)
      .where(
        and(
          eq(voiceGatewaySessions.organisationId, input.organisationId),
          eq(voiceGatewaySessions.idempotencyKey, input.idempotencyKey)
        )
      )
      .limit(1);
    if (byIdempotency[0] !== undefined) {
      return commandMatches(byIdempotency[0], input)
        ? { kind: 'existing', session: byIdempotency[0] }
        : { kind: 'conflict', code: 'GATEWAY_COMMAND_CONFLICT' };
    }

    const conflictingCall = await this.database
      .select({ gatewayCallId: voiceGatewaySessions.gatewayCallId })
      .from(voiceGatewaySessions)
      .where(eq(voiceGatewaySessions.gatewayCallId, input.gatewayCallId))
      .limit(1);
    if (conflictingCall.length > 0) {
      return { kind: 'conflict', code: 'GATEWAY_COMMAND_CONFLICT' };
    }

    const busy = await this.database
      .select({ gatewayCallId: voiceGatewaySessions.gatewayCallId })
      .from(voiceGatewaySessions)
      .where(
        and(
          eq(voiceGatewaySessions.organisationId, input.organisationId),
          eq(voiceGatewaySessions.providerUserNumber, input.providerUserNumber),
          inArray(voiceGatewaySessions.state, activeStates)
        )
      )
      .limit(1);
    return {
      kind: 'conflict',
      code: busy.length > 0 ? 'GATEWAY_USER_BUSY' : 'GATEWAY_COMMAND_CONFLICT'
    };
  }

  async findByGatewayCallId(
    gatewayCallId: string
  ): Promise<GatewaySessionRecord | null> {
    const rows = await this.database
      .select()
      .from(voiceGatewaySessions)
      .where(eq(voiceGatewaySessions.gatewayCallId, gatewayCallId))
      .limit(1);
    return rows[0] ?? null;
  }

  async applyEvent(
    event: GatewayCallEvent,
    now: Date
  ): Promise<GatewaySessionRecord | null> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = await this.findByGatewayCallId(event.gatewayCallId);
      if (current === null) return null;
      const next = advanceGatewayCall(current, event);
      if (next === current) return current;
      const updated = await this.database
        .update(voiceGatewaySessions)
        .set({
          state: next.state,
          lastEventSequence: next.lastEventSequence,
          safeFailureCode: next.safeFailureCode,
          updatedAt: now
        })
        .where(
          and(
            eq(voiceGatewaySessions.gatewayCallId, event.gatewayCallId),
            eq(
              voiceGatewaySessions.lastEventSequence,
              current.lastEventSequence
            )
          )
        )
        .returning();
      if (updated[0] !== undefined) return updated[0];
    }
    return this.findByGatewayCallId(event.gatewayCallId);
  }
}
