ALTER TABLE "reply_number_provisioning_requests" DROP CONSTRAINT "reply_number_requests_failed_provenance_ck";--> statement-breakpoint
ALTER TABLE "reply_number_provisioning_requests" ADD CONSTRAINT "reply_number_requests_failed_provenance_ck" CHECK ("reply_number_provisioning_requests"."status" <> 'FAILED' or (
            (
              "reply_number_provisioning_requests"."approved_by_user_id" is null or (
                "reply_number_provisioning_requests"."quote_setup_fee_minor" is not null and
                "reply_number_provisioning_requests"."quote_monthly_fee_minor" is not null and
                "reply_number_provisioning_requests"."quote_currency" = 'aud' and
                "reply_number_provisioning_requests"."quote_expires_at" is not null and
                "reply_number_provisioning_requests"."quoted_at" is not null and
                "reply_number_provisioning_requests"."documentation_status" <> 'UNKNOWN'
              )
            ) and (
              "reply_number_provisioning_requests"."external_order_reference" is null or (
                "reply_number_provisioning_requests"."approved_by_user_id" is not null and
                "reply_number_provisioning_requests"."documentation_status" in ('NOT_REQUIRED', 'COMPLETE')
              )
            )
          ));