ALTER TABLE organisations
  ADD COLUMN sinch_shared_account_id varchar(128),
  ADD COLUMN sinch_shared_account_linked_at timestamptz,
  ADD CONSTRAINT organisations_sinch_shared_account_ck CHECK (
    (sinch_shared_account_id IS NULL AND sinch_shared_account_linked_at IS NULL)
    OR (edition = 'SOLO' AND sinch_shared_account_id IS NOT NULL
      AND sinch_shared_account_id ~ '^[A-Za-z0-9_-]{1,128}$'
      AND sinch_shared_account_linked_at IS NOT NULL)
  );
--> statement-breakpoint
CREATE UNIQUE INDEX organisations_sinch_shared_account_uq
  ON organisations (sinch_shared_account_id);
--> statement-breakpoint
ALTER TABLE message_attempts
  ADD COLUMN sinch_account_id varchar(128),
  ADD CONSTRAINT message_attempts_sinch_account_ck CHECK (
    sinch_account_id IS NULL OR (provider = 'SINCH'
      AND sinch_account_id ~ '^[A-Za-z0-9_-]{1,128}$')
  );
--> statement-breakpoint
CREATE INDEX message_attempts_provider_message_idx
  ON message_attempts (provider, provider_message_id);
