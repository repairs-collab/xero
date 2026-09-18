# RDS restore runbook

Always restore to a new private instance. Never overwrite or delete the source during recovery.

1. Disable live sending, scale the worker service to zero, and record the incident and chosen recovery point.
2. In AWS Console → RDS → Automated backups, select the production Bill Chaser database and choose **Restore to point in time**. Use the latest restorable time before the incident, a new identifier, PostgreSQL 17, the isolated database subnet group, the existing database security group, KMS encryption, Multi-AZ, deletion protection, and no public access.
3. Wait for `available`, then retrieve its endpoint. Create a new database application secret version/reference; do not modify the source secret yet.
4. Run the migration image against the restored database. From a private one-off ECS task, run `node /app/worker.mjs migrate` with the restored endpoint.
5. Validate before cutover:

   ```sql
   select count(*) from organisations;
   select status, count(*) from stage_instances group by status order by status;
   select status, count(*) from outbound_messages group by status order by status;
   select count(*) from audit_events;
   select count(*) from webhook_events where processed_at is null;
   ```

6. Compare the last Xero sync timestamp, open invoice totals, pending approvals, open escalations, unknown sends, and audit-event maximum timestamp against pre-incident evidence. Run a dry-run Xero reconciliation before any send.
7. Update staging/web/worker database references to the restored instance, force deployments, and smoke test `/health/ready`. Start one worker task with live sending still disabled and drain only non-send jobs.
8. Run the controlled test cohort. Obtain incident commander and finance-owner approval before re-enabling live sending.
9. Retain the old instance and both secret versions until the post-incident review and backup verification are complete.
