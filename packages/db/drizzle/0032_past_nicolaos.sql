ALTER TABLE "reply_number_provisioning_requests" DROP CONSTRAINT "reply_number_requests_org_number_fk";
--> statement-breakpoint
ALTER TABLE "reply_number_provisioning_requests" ADD CONSTRAINT "reply_number_requests_number_fk" FOREIGN KEY ("fulfilled_number_id") REFERENCES "public"."sms_number_pool"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE FUNCTION reply_number_assert_fulfilled_org() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  assigned_organisation_id uuid;
BEGIN
  IF NEW.fulfilled_number_id IS NOT NULL THEN
    SELECT organisation_id
      INTO assigned_organisation_id
      FROM sms_number_pool
      WHERE id = NEW.fulfilled_number_id;
    IF assigned_organisation_id IS DISTINCT FROM NEW.organisation_id THEN
      RAISE EXCEPTION 'fulfilled reply number organisation mismatch'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER reply_number_fulfilled_org_guard
BEFORE INSERT OR UPDATE OF fulfilled_number_id, organisation_id
ON reply_number_provisioning_requests
FOR EACH ROW EXECUTE FUNCTION reply_number_assert_fulfilled_org();
