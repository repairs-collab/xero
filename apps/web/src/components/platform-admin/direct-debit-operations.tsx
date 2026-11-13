'use client';

import { useActionState } from 'react';

import type { DirectDebitOwnerSnapshot } from '../../server/subscription-service.js';

type DirectDebitActionState =
  | { kind: 'IDLE' }
  | {
      kind: 'SETUP_LINK_CREATED';
      customerEmail: string;
      setupUrl: string;
    }
  | { kind: 'ACTIVATED' }
  | { kind: 'RECONCILED' }
  | { kind: 'VALIDATION' }
  | { kind: 'INVALID_STATE' }
  | { kind: 'FAILED' };

type StateAction = (
  state: DirectDebitActionState,
  formData: FormData
) => Promise<DirectDebitActionState>;

const dateTime = (value: Date | null): string =>
  value === null
    ? '—'
    : new Intl.DateTimeFormat('en-AU', {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone: 'Australia/Sydney'
      }).format(value);

const stateMessage = (state: DirectDebitActionState): string | null => {
  if (state.kind === 'ACTIVATED') return 'Direct debit is now active.';
  if (state.kind === 'RECONCILED') {
    return 'Provider reconciliation recorded. Review any remaining legacy records before inviting a fresh request.';
  }
  if (state.kind === 'VALIDATION') return 'Confirm the owner action first.';
  if (state.kind === 'INVALID_STATE') {
    return 'The request is no longer in the required state. Refresh and review it.';
  }
  if (state.kind === 'FAILED') {
    return 'The owner action failed. No customer instructions were sent.';
  }
  return null;
};

export function PlatformDirectDebitOperationsView({
  snapshot,
  setupState,
  activationState,
  reconciliationState,
  createSetupLinkAction,
  activateDirectDebitAction,
  reconcileLegacyDirectDebitAction,
  setupPending = false,
  activationPending = false
}: {
  snapshot: DirectDebitOwnerSnapshot;
  setupState: DirectDebitActionState;
  activationState: DirectDebitActionState;
  reconciliationState: DirectDebitActionState;
  createSetupLinkAction: (formData: FormData) => void;
  activateDirectDebitAction: (formData: FormData) => void;
  reconcileLegacyDirectDebitAction: (formData: FormData) => void;
  setupPending?: boolean;
  activationPending?: boolean;
}) {
  const request = snapshot.request;
  const legacy = snapshot.legacyReconciliation;
  const reconciliationRequired =
    legacy !== null && legacy.providerReconciledAt === null;
  const message =
    stateMessage(reconciliationState) ??
    stateMessage(activationState) ??
    stateMessage(setupState);
  return (
    <article className="panel platform-control-card">
      <span className="eyebrow">Request-only payment method</span>
      <h2>Australian direct debit</h2>
      <p>
        First payment remains card-only. Bank details are collected only on
        Stripe’s hosted page and are never stored by AccountPulse.
      </p>
      <dl className="detail-grid">
        <div>
          <dt>Billing cadence</dt>
          <dd>{snapshot.billingCadence}</dd>
        </div>
        <div>
          <dt>Initial card invoice</dt>
          <dd>{snapshot.initialCardInvoiceId ?? 'Not confirmed'}</dd>
        </div>
        <div>
          <dt>Initial card payment</dt>
          <dd>{dateTime(snapshot.initialCardPaymentSucceededAt)}</dd>
        </div>
        <div>
          <dt>Direct-debit state</dt>
          <dd>
            {reconciliationRequired
              ? 'RECONCILIATION_REQUIRED'
              : (request?.status ?? 'NOT_REQUESTED')}
          </dd>
        </div>
        <div>
          <dt>Requesting customer</dt>
          <dd>{request?.requesterEmail ?? '—'}</dd>
        </div>
        <div>
          <dt>Requested</dt>
          <dd>{dateTime(request?.requestedAt ?? null)}</dd>
        </div>
        <div>
          <dt>Setup Intent</dt>
          <dd>{request?.setupIntentId ?? '—'}</dd>
        </div>
        <div>
          <dt>Mandate evidence</dt>
          <dd>{request?.stripeMandateId ?? '—'}</dd>
        </div>
      </dl>

      {reconciliationRequired ? (
        <form action={reconcileLegacyDirectDebitAction}>
          <input
            type="hidden"
            name="organisationId"
            value={snapshot.organisationId}
          />
          <div className="callout callout--warning">
            <strong>Provider reconciliation required</strong>
            <p>
              Historical state ({legacy.legacyStatus}) cannot be treated as a
              current customer request. Inspect the Stripe subscription’s
              default payment method and resolve or record the result before
              allowing another direct-debit request.
            </p>
          </div>
          <label>
            Resolved provider outcome
            <select name="reconciliationOutcome" required defaultValue="">
              <option value="" disabled>
                Select the verified result
              </option>
              <option value="NO_LEGACY_DEFAULT">
                No legacy default payment method remains
              </option>
              <option value="LEGACY_DEFAULT_REMOVED">
                Legacy default payment method was removed
              </option>
            </select>
          </label>
          <p className="muted-copy">
            AccountPulse records only this outcome, the owner, and the time. It
            does not store bank account, BSB, card, or other payment details.
          </p>
          <label className="platform-confirm">
            <input
              type="checkbox"
              name="confirmation"
              value="confirmed"
              required
            />
            <span>
              I inspected the Stripe subscription default payment method and
              confirm the selected safe outcome is true.
            </span>
          </label>
          <button className="button button--primary">
            Record provider reconciliation
          </button>
        </form>
      ) : null}

      {request?.status === 'REQUESTED' ||
      request?.status === 'SETUP_PENDING' ? (
        <form action={createSetupLinkAction}>
          <input
            type="hidden"
            name="organisationId"
            value={snapshot.organisationId}
          />
          <label className="platform-confirm">
            <input
              type="checkbox"
              name="confirmation"
              value="confirmed"
              required
            />
            <span>
              I confirmed this customer requested direct debit and will deliver
              the link to that customer only.
            </span>
          </label>
          <p className="muted-copy">
            Do not open the link or enter bank details on the customer’s behalf.
          </p>
          <button className="button button--primary" disabled={setupPending}>
            Generate customer setup link
          </button>
        </form>
      ) : null}

      {setupState.kind === 'SETUP_LINK_CREATED' ? (
        <div className="callout" role="status">
          <strong>
            Deliver this link only to {setupState.customerEmail}
          </strong>
          <label>
            Customer Stripe-hosted setup link
            <input readOnly value={setupState.setupUrl} />
          </label>
          <p>
            The platform owner must not complete this form. Direct debit stays
            inactive until Stripe confirms mandate evidence and an owner uses
            the separate activation control.
          </p>
        </div>
      ) : null}

      {request?.status === 'MANDATE_CONFIRMED' ? (
        <form action={activateDirectDebitAction}>
          <input
            type="hidden"
            name="organisationId"
            value={snapshot.organisationId}
          />
          <div className="callout">
            <strong>Provider-confirmed mandate</strong>
            <p>
              Confirmed {dateTime(request.mandateConfirmedAt)}. Payment method{' '}
              {request.stripePaymentMethodId}; mandate {request.stripeMandateId}.
            </p>
          </div>
          <label className="platform-confirm">
            <input
              type="checkbox"
              name="confirmation"
              value="confirmed"
              required
            />
            <span>
              I verified the customer request and provider-confirmed mandate.
            </span>
          </label>
          <button
            className="button button--primary"
            disabled={activationPending}
          >
            Activate direct debit
          </button>
        </form>
      ) : null}

      {message !== null ? (
        <div className="platform-feedback" role="status">
          {message}
        </div>
      ) : null}
    </article>
  );
}

export function PlatformDirectDebitOperations({
  snapshot,
  actions
}: {
  snapshot: DirectDebitOwnerSnapshot;
  actions: {
    createSetupLink: StateAction;
    activate: StateAction;
    reconcileLegacy: StateAction;
  };
}) {
  const [setupState, createSetupLinkAction, setupPending] = useActionState(
    actions.createSetupLink,
    { kind: 'IDLE' }
  );
  const [activationState, activateDirectDebitAction, activationPending] =
    useActionState(actions.activate, { kind: 'IDLE' });
  const [reconciliationState, reconcileLegacyDirectDebitAction] =
    useActionState(actions.reconcileLegacy, { kind: 'IDLE' });
  return (
    <PlatformDirectDebitOperationsView
      snapshot={snapshot}
      setupState={setupState}
      activationState={activationState}
      reconciliationState={reconciliationState}
      createSetupLinkAction={createSetupLinkAction}
      activateDirectDebitAction={activateDirectDebitAction}
      reconcileLegacyDirectDebitAction={reconcileLegacyDirectDebitAction}
      setupPending={setupPending}
      activationPending={activationPending}
    />
  );
}
