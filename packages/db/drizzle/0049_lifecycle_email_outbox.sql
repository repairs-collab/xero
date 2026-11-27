CREATE TABLE lifecycle_email_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  recipient varchar(320) NOT NULL,
  template varchar(32) NOT NULL,
  template_version integer NOT NULL DEFAULT 1,
  render_data jsonb NOT NULL,
  idempotency_key text NOT NULL,
  source_type varchar(64) NOT NULL,
  source_id text NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'PENDING',
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  next_attempt_at timestamptz,
  claim_token uuid,
  cancellation_requested_at timestamptz,
  message_id varchar(512),
  provider_message_id varchar(512),
  last_failure_code varchar(64),
  last_attempted_at timestamptz,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lifecycle_email_status_ck CHECK (status IN ('PENDING','SENDING','RETRY','SENT','FAILED','UNKNOWN','CANCELLED')),
  CONSTRAINT lifecycle_email_template_ck CHECK (template IN ('WORKSPACE_WELCOME','ONBOARDING_COMPLETED','PAYMENT_CONFIRMED','SMS_USAGE_WARNING','PAYMENT_FAILED','PAYMENT_RECOVERED','CANCELLATION_SCHEDULED','CANCELLATION_EFFECTIVE','EXPORT_DELIVERED','PRIVACY_REQUEST_RECEIVED')),
  CONSTRAINT lifecycle_email_render_ck CHECK (jsonb_typeof(render_data) = 'object' AND NOT jsonb_path_exists(render_data, 'strict $.* ? (@.type() == "array" || @.type() == "object")')),
  CONSTRAINT lifecycle_email_identity_ck CHECK (btrim(idempotency_key) <> '' AND btrim(source_type) <> '' AND btrim(source_id) <> '' AND template_version > 0),
  CONSTRAINT lifecycle_email_recipient_ck CHECK (recipient = lower(btrim(recipient)) AND recipient ~ '^[^[:space:][:cntrl:]@,;:<>"]+@[^[:space:][:cntrl:]@,;:<>"]+[.][^[:space:][:cntrl:]@,;:<>"]+$'),
  CONSTRAINT lifecycle_email_expiry_ck CHECK (expires_at > available_at),
  CONSTRAINT lifecycle_email_attempt_ck CHECK (attempts >= 0 AND (attempts = 0) = (last_attempted_at IS NULL) AND (status NOT IN ('SENDING','RETRY','SENT','FAILED','UNKNOWN') OR attempts > 0)),
  CONSTRAINT lifecycle_email_claim_ck CHECK ((status = 'SENDING') = (claim_token IS NOT NULL)),
  CONSTRAINT lifecycle_email_retry_ck CHECK ((status = 'RETRY') = (next_attempt_at IS NOT NULL) AND (next_attempt_at IS NULL OR (next_attempt_at > last_attempted_at AND next_attempt_at < expires_at))),
  CONSTRAINT lifecycle_email_sent_ck CHECK (
    (status <> 'SENT' AND sent_at IS NULL AND message_id IS NULL AND provider_message_id IS NULL)
    OR (status = 'SENT' AND sent_at IS NOT NULL AND message_id IS NOT NULL
        AND message_id COLLATE "C" ~ '^<[A-Za-z0-9_-]+([.][A-Za-z0-9_-]+)*@[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?([.][A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*>$'
        AND (provider_message_id IS NULL OR (provider_message_id ~ '[^[:space:]]' AND provider_message_id !~ '[[:cntrl:]]')))
  ),
  CONSTRAINT lifecycle_email_cancellation_ck CHECK (cancellation_requested_at IS NULL OR status IN ('SENDING','CANCELLED','SENT','UNKNOWN')),
  CONSTRAINT lifecycle_email_failure_code_ck CHECK (last_failure_code ~ '^[A-Z][A-Z0-9_]{0,63}$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX lifecycle_email_org_idempotency_uq ON lifecycle_email_outbox (organisation_id, idempotency_key);
--> statement-breakpoint
CREATE INDEX lifecycle_email_pending_idx ON lifecycle_email_outbox (available_at, id) WHERE status = 'PENDING';
--> statement-breakpoint
CREATE INDEX lifecycle_email_retry_idx ON lifecycle_email_outbox (next_attempt_at, id) WHERE status = 'RETRY';
--> statement-breakpoint
CREATE INDEX lifecycle_email_expiry_idx ON lifecycle_email_outbox (expires_at) WHERE status IN ('PENDING','RETRY');
--> statement-breakpoint
CREATE INDEX lifecycle_email_sending_idx ON lifecycle_email_outbox (last_attempted_at) WHERE status = 'SENDING';
--> statement-breakpoint
CREATE INDEX lifecycle_email_source_idx ON lifecycle_email_outbox (organisation_id, source_type, source_id, template);
--> statement-breakpoint
CREATE INDEX lifecycle_email_org_status_created_idx ON lifecycle_email_outbox (organisation_id, status, created_at);
