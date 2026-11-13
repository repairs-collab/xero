CREATE OR REPLACE FUNCTION transactional_email_render_data_immutable_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.id IS DISTINCT FROM NEW.id OR
     OLD.created_at IS DISTINCT FROM NEW.created_at OR
     OLD.organisation_id IS DISTINCT FROM NEW.organisation_id OR
     OLD.billing_case_id IS DISTINCT FROM NEW.billing_case_id OR
     OLD.recipient IS DISTINCT FROM NEW.recipient OR
     OLD.template IS DISTINCT FROM NEW.template OR
     OLD.template_version IS DISTINCT FROM NEW.template_version OR
     OLD.render_data IS DISTINCT FROM NEW.render_data OR
     OLD.idempotency_key IS DISTINCT FROM NEW.idempotency_key OR
     OLD.source_event_id IS DISTINCT FROM NEW.source_event_id THEN
    RAISE EXCEPTION 'transactional_email_outbox evidence is immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS transactional_email_render_data_immutable
ON transactional_email_outbox;--> statement-breakpoint
CREATE TRIGGER transactional_email_render_data_immutable
BEFORE UPDATE OF id, created_at, organisation_id, billing_case_id, recipient,
  template, template_version, render_data, idempotency_key, source_event_id
ON transactional_email_outbox
FOR EACH ROW EXECUTE FUNCTION transactional_email_render_data_immutable_guard();
