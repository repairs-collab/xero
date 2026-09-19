# Deployment runbook

Bill Chaser 5000 deploys only to `ap-southeast-2`. Development, staging, and production are separate CDK stages. Production requires the protected GitHub `production` environment approval.

## One-time setup

1. Bootstrap each AWS account:

   ```bash
   export AWS_REGION=ap-southeast-2
   export CDK_DEFAULT_ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
   pnpm --filter @bc5000/infra cdk bootstrap "aws://${CDK_DEFAULT_ACCOUNT}/${AWS_REGION}"
   ```

2. Create an ACM certificate in Sydney for the environment hostname and validate it in DNS.
3. Configure GitHub environments `staging` and `production` with variables `AWS_DEPLOY_ROLE_ARN`, `AWS_ACCOUNT_ID`, `CERTIFICATE_ARN`, and `HOSTNAME`. Require named reviewers on production.
4. The OIDC deploy role may deploy the Bill Chaser stacks, push/scan the two named ECR repositories, and run/wait for migration tasks. It must not administer unrelated resources.

## Normal release

Run the `Deploy Bill Chaser 5000` workflow. It verifies dependencies and tests, builds the web and worker images once, saves the exact images as a short-lived artifact, pushes SHA-tagged copies, waits for ECR scanning, deploys staging, runs the migration task, and performs `/health/ready` smoke testing. The same image artifact is promoted after production approval.

Never deploy a mutable `latest` tag. Record the Git SHA, workflow URL, CDK change sets, migration task ARN, and smoke-test result in the launch evidence.

## Rollback

1. In Admin Settings → Sending controls, disable live sending and record the incident reason.
2. Stop new worker claims without killing in-flight sends:

   ```bash
   aws ecs update-service --region ap-southeast-2 --cluster "$CLUSTER" --service "$WORKER_SERVICE" --desired-count 0
   aws ecs wait services-stable --region ap-southeast-2 --cluster "$CLUSTER" --services "$WORKER_SERVICE"
   ```

3. Inspect `UNKNOWN` send outcomes before any resend. Follow `unknown-send-outcome.md`.
4. Redeploy the last known-good SHA through the workflow or update both services to its prior task-definition revisions.
5. Database migrations are forward-only. If application rollback is incompatible with the schema, restore to a new RDS instance using `restore.md` and do not overwrite the source instance.
6. Resume the worker at one task, verify queue age and provider health, then restore the normal desired count.

## Secret rotation

Update Secrets Manager with a new version, test it in Admin Settings → Integrations, then force a deployment so ECS tasks receive the new value:

```bash
aws ecs update-service --region ap-southeast-2 --cluster "$CLUSTER" --service "$WEB_SERVICE" --force-new-deployment
aws ecs update-service --region ap-southeast-2 --cluster "$CLUSTER" --service "$WORKER_SERVICE" --force-new-deployment
```

Keep the previous secret version until the new tasks are healthy. For Sinch callback key rotation, keep both public key IDs in the callback-key JSON during the overlap; remove the old key only after no callbacks use it.
