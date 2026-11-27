ALTER TABLE data_request_cases
  ADD COLUMN verified_requester_email varchar(320);
--> statement-breakpoint
ALTER TABLE data_request_cases
  ADD CONSTRAINT data_request_cases_requester_email_ck
  CHECK (
    verified_requester_email IS NULL OR (
      verified_requester_email = lower(btrim(verified_requester_email))
      AND verified_requester_email ~ '^[^[:space:][:cntrl:]@,;:<>"]+@[^[:space:][:cntrl:]@,;:<>"]+[.][^[:space:][:cntrl:]@,;:<>"]+$'
    )
  );
