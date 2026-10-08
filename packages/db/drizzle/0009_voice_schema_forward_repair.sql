DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 'organisation_voice_settings'
       AND column_name = 'secret_arn'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 'organisation_voice_settings'
       AND column_name = 'secret_reference'
  ) THEN
    ALTER TABLE organisation_voice_settings
      RENAME COLUMN secret_arn TO secret_reference;
  ELSIF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 'organisation_voice_settings'
       AND column_name = 'secret_arn'
  ) THEN
    UPDATE organisation_voice_settings
       SET secret_reference = secret_arn
     WHERE secret_reference IS NULL OR secret_reference = '';
    ALTER TABLE organisation_voice_settings DROP COLUMN secret_arn;
  END IF;
END;
$$;
--> statement-breakpoint
ALTER TABLE organisation_voice_settings
  ADD COLUMN IF NOT EXISTS configuration_version integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE organisation_voice_settings
  DROP COLUMN IF EXISTS voicemail_template;
--> statement-breakpoint
ALTER TABLE organisation_voice_settings
  DROP CONSTRAINT IF EXISTS organisation_voice_settings_configuration_version_ck;
--> statement-breakpoint
ALTER TABLE organisation_voice_settings
  ADD CONSTRAINT organisation_voice_settings_configuration_version_ck
  CHECK (configuration_version >= 0);
--> statement-breakpoint
DROP TRIGGER IF EXISTS voice_call_requests_facts_immutable_after_approval
  ON voice_call_requests;
--> statement-breakpoint
ALTER TABLE voice_call_requests
  DROP CONSTRAINT IF EXISTS voice_call_requests_approved_facts_ck;
--> statement-breakpoint
ALTER TABLE voice_call_requests
  DROP CONSTRAINT IF EXISTS voice_call_requests_draft_facts_ck;
--> statement-breakpoint
ALTER TABLE voice_call_requests
  DROP CONSTRAINT IF EXISTS voice_call_requests_state_ck;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 'voice_call_requests'
       AND column_name = 'script_version'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 'voice_call_requests'
       AND column_name = 'call_flow_version'
  ) THEN
    ALTER TABLE voice_call_requests
      RENAME COLUMN script_version TO call_flow_version;
  ELSIF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 'voice_call_requests'
       AND column_name = 'script_version'
  ) THEN
    UPDATE voice_call_requests
       SET call_flow_version = COALESCE(call_flow_version, script_version);
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 'voice_call_requests'
       AND column_name = 'script_hash'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 'voice_call_requests'
       AND column_name = 'call_flow_hash'
  ) THEN
    ALTER TABLE voice_call_requests
      RENAME COLUMN script_hash TO call_flow_hash;
  ELSIF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 'voice_call_requests'
       AND column_name = 'script_hash'
  ) THEN
    UPDATE voice_call_requests
       SET call_flow_hash = COALESCE(call_flow_hash, script_hash);
  END IF;
END;
$$;
--> statement-breakpoint
ALTER TABLE voice_call_requests
  ADD COLUMN IF NOT EXISTS approved_facts_hash text;
--> statement-breakpoint
UPDATE voice_call_requests
   SET state = 'DRAFT',
       call_flow_version = NULL,
       call_flow_hash = NULL,
       approved_facts_hash = NULL,
       approved_at = NULL,
       queued_at = NULL
 WHERE state = 'PREVIEWED';
--> statement-breakpoint
UPDATE voice_call_requests
   SET call_flow_version = NULL,
       call_flow_hash = NULL,
       approved_facts_hash = NULL,
       approved_at = NULL,
       queued_at = NULL
 WHERE state = 'DRAFT';
--> statement-breakpoint
UPDATE voice_call_requests
   SET call_flow_version = COALESCE(call_flow_version, 1),
       call_flow_hash = COALESCE(
         call_flow_hash,
         'legacy-unverified:' || id::text
       ),
       approved_facts_hash = COALESCE(
         approved_facts_hash,
         'legacy-unverified:' || id::text
       ),
       approved_at = COALESCE(approved_at, updated_at, created_at, now())
 WHERE state IN (
   'APPROVED', 'QUEUED', 'SUBMITTING', 'ACCEPTED',
   'IN_PROGRESS', 'COMPLETED', 'FAILED', 'UNKNOWN'
 );
--> statement-breakpoint
ALTER TABLE voice_call_requests
  DROP COLUMN IF EXISTS approved_script,
  DROP COLUMN IF EXISTS script_hash,
  DROP COLUMN IF EXISTS script_version,
  DROP COLUMN IF EXISTS previewed_at;
--> statement-breakpoint
ALTER TABLE voice_call_requests
  ADD CONSTRAINT voice_call_requests_state_ck CHECK (
    state IN (
      'DRAFT', 'APPROVED', 'QUEUED', 'SUBMITTING', 'ACCEPTED',
      'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'FAILED', 'UNKNOWN'
    )
  );
--> statement-breakpoint
ALTER TABLE voice_call_requests
  ADD CONSTRAINT voice_call_requests_approved_facts_ck CHECK (
    state NOT IN (
      'APPROVED', 'QUEUED', 'SUBMITTING', 'ACCEPTED',
      'IN_PROGRESS', 'COMPLETED', 'FAILED', 'UNKNOWN'
    ) OR (
      call_flow_version IS NOT NULL
      AND call_flow_hash IS NOT NULL
      AND approved_facts_hash IS NOT NULL
      AND approved_at IS NOT NULL
    )
  );
--> statement-breakpoint
ALTER TABLE voice_call_requests
  ADD CONSTRAINT voice_call_requests_draft_facts_ck CHECK (
    state <> 'DRAFT' OR (
      call_flow_version IS NULL
      AND call_flow_hash IS NULL
      AND approved_facts_hash IS NULL
      AND approved_at IS NULL
      AND queued_at IS NULL
    )
  );
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS contacts_org_id_uq
  ON contacts (organisation_id, id);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS invoices_org_id_uq
  ON invoices (organisation_id, id);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS voice_call_requests_org_id_uq
  ON voice_call_requests (organisation_id, id);
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'voice_call_requests_org_contact_fk'
       AND conrelid = 'voice_call_requests'::regclass
  ) THEN
    ALTER TABLE voice_call_requests
      ADD CONSTRAINT voice_call_requests_org_contact_fk
      FOREIGN KEY (organisation_id, contact_id)
      REFERENCES contacts (organisation_id, id)
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'voice_call_invoices_org_call_fk'
       AND conrelid = 'voice_call_invoices'::regclass
  ) THEN
    ALTER TABLE voice_call_invoices
      ADD CONSTRAINT voice_call_invoices_org_call_fk
      FOREIGN KEY (organisation_id, voice_call_id)
      REFERENCES voice_call_requests (organisation_id, id)
      ON DELETE CASCADE
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'voice_call_invoices_org_invoice_fk'
       AND conrelid = 'voice_call_invoices'::regclass
  ) THEN
    ALTER TABLE voice_call_invoices
      ADD CONSTRAINT voice_call_invoices_org_invoice_fk
      FOREIGN KEY (organisation_id, invoice_id)
      REFERENCES invoices (organisation_id, id)
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'voice_call_events_org_call_fk'
       AND conrelid = 'voice_call_events'::regclass
  ) THEN
    ALTER TABLE voice_call_events
      ADD CONSTRAINT voice_call_events_org_call_fk
      FOREIGN KEY (organisation_id, voice_call_id)
      REFERENCES voice_call_requests (organisation_id, id)
      ON DELETE CASCADE
      NOT VALID;
  END IF;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION protect_approved_voice_call_invoice_snapshot()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  old_parent_state varchar(24);
  new_parent_state varchar(24);
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    SELECT state INTO old_parent_state
      FROM voice_call_requests
     WHERE id = OLD.voice_call_id;
  END IF;

  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    SELECT state INTO new_parent_state
      FROM voice_call_requests
     WHERE id = NEW.voice_call_id;
  END IF;

  IF old_parent_state IS DISTINCT FROM NULL
     AND old_parent_state IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'approved voice call invoice snapshots are immutable';
  END IF;

  IF new_parent_state IS DISTINCT FROM NULL
     AND new_parent_state IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'approved voice call invoice snapshots are immutable';
  END IF;

  IF TG_OP = 'UPDATE' AND (
    NEW.voice_call_id IS DISTINCT FROM OLD.voice_call_id OR
    NEW.organisation_id IS DISTINCT FROM OLD.organisation_id OR
    NEW.invoice_id IS DISTINCT FROM OLD.invoice_id
  ) THEN
    RAISE EXCEPTION 'voice call invoice snapshot identity is immutable';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS voice_call_invoices_immutable_after_approval
  ON voice_call_invoices;
--> statement-breakpoint
CREATE TRIGGER voice_call_invoices_immutable_after_approval
BEFORE INSERT OR UPDATE OR DELETE ON voice_call_invoices
FOR EACH ROW EXECUTE FUNCTION protect_approved_voice_call_invoice_snapshot();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION protect_approved_voice_call_facts()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.state <> 'DRAFT' AND (
    NEW.organisation_id IS DISTINCT FROM OLD.organisation_id OR
    NEW.contact_id IS DISTINCT FROM OLD.contact_id OR
    NEW.actor_user_id IS DISTINCT FROM OLD.actor_user_id OR
    NEW.destination_number IS DISTINCT FROM OLD.destination_number OR
    NEW.outbound_number IS DISTINCT FROM OLD.outbound_number OR
    NEW.combined_amount IS DISTINCT FROM OLD.combined_amount OR
    NEW.currency IS DISTINCT FROM OLD.currency OR
    NEW.call_flow_version IS DISTINCT FROM OLD.call_flow_version OR
    NEW.call_flow_hash IS DISTINCT FROM OLD.call_flow_hash OR
    NEW.approved_facts_hash IS DISTINCT FROM OLD.approved_facts_hash OR
    NEW.agent_id IS DISTINCT FROM OLD.agent_id OR
    NEW.agent_version IS DISTINCT FROM OLD.agent_version OR
    NEW.voice_id IS DISTINCT FROM OLD.voice_id OR
    NEW.voice_settings_updated_at IS DISTINCT FROM OLD.voice_settings_updated_at OR
    NEW.transfer_target_label IS DISTINCT FROM OLD.transfer_target_label OR
    NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
  ) THEN
    RAISE EXCEPTION 'approved voice call facts are immutable';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER voice_call_requests_facts_immutable_after_approval
BEFORE UPDATE ON voice_call_requests
FOR EACH ROW EXECUTE FUNCTION protect_approved_voice_call_facts();
