"""Read-only OVH evidence for the 2026-11-20 Motts processing incident."""
import datetime
import json
import re
import subprocess

def run(args, data=None):
    result = subprocess.run(args, input=data, text=True, capture_output=True, timeout=45)
    if result.returncode:
        raise RuntimeError(result.stderr[:500])
    return result.stdout

containers = json.loads(run(['docker', 'inspect', 'bc5000-worker', 'bc5000-web', 'bc5000-postgres']))
secrets = []
worker_env = {}
for container in containers:
    env = dict(value.split('=', 1) for value in container['Config']['Env'] if '=' in value)
    secrets.extend(value for key, value in env.items() if re.search('SECRET|PASSWORD|TOKEN|CREDENTIAL|KEY|DATABASE_URL', key) and len(value) > 4)
    for key, value in env.items():
        if 'CREDENTIAL' in key:
            try:
                secrets.extend(v for v in json.loads(value).values() if isinstance(v, str) and len(v) > 4)
            except (ValueError, AttributeError):
                pass
    if container['Name'] == '/bc5000-worker':
        worker_env = env

def clean(value):
    text = str(value)
    for secret in sorted(secrets, key=len, reverse=True):
        text = text.replace(secret, '[REDACTED]')
    text = re.sub(r'\+\d{9,15}', '[PHONE]', text)
    text = re.sub(r'[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}', '[EMAIL]', text)
    return text

def emit(label, value):
    print(label + ': ' + clean(json.dumps(value, default=str)), flush=True)

emit('checked_at_utc', datetime.datetime.now(datetime.timezone.utc).isoformat())
emit('ssh_identity', run(['id', '-un']).strip())
emit('ssh_uid', run(['id', '-u']).strip())
timer = subprocess.run(['systemctl', 'is-active', 'accountpulse-server-health.timer'], capture_output=True, text=True, timeout=15)
emit('server_health_timer', {'status': timer.stdout.strip(), 'exitCode': timer.returncode})
for container in containers:
    state = container['State']
    emit('container', {'name': container['Name'], 'image': container['Config']['Image'], 'imageId': container['Image'], 'status': state['Status'], 'running': state['Running'], 'restarting': state['Restarting'], 'exitCode': state['ExitCode'], 'oomKilled': state['OOMKilled'], 'startedAt': state['StartedAt'], 'finishedAt': state['FinishedAt'], 'restartCount': container['RestartCount']})
price_names = ['STRIPE_SOLO_MONTHLY_PRICE_ID', 'STRIPE_SOLO_ANNUAL_PRICE_ID', 'STRIPE_SMS_OVERAGE_PRICE_ID']
emit('stripe_configuration', {'present': {key: bool(worker_env.get(key)) for key in price_names}, 'equalPairs': [[a,b] for i,a in enumerate(price_names) for b in price_names[i+1:] if worker_env.get(a) and worker_env.get(a)==worker_env.get(b)]})
logs = subprocess.run(['docker', 'logs', '--timestamps', '--tail', '100', 'bc5000-worker'], capture_output=True, text=True, timeout=30)
emit('worker_logs', list(dict.fromkeys(re.sub(r'^\S+ ', '', line) for line in (logs.stdout + logs.stderr).splitlines())))

db_env = dict(value.split('=', 1) for value in containers[2]['Config']['Env'] if '=' in value)
def query(sql):
    # Both session default and explicit transaction prohibit writes.
    command = ['docker','exec','-i','-e','PGOPTIONS=-c default_transaction_read_only=on -c statement_timeout=15000','bc5000-postgres','psql','-X','-q','-t','-A','-v','ON_ERROR_STOP=1','-U',db_env['POSTGRES_USER'],'-d',db_env['POSTGRES_DB']]
    raw = run(command, 'BEGIN READ ONLY; SELECT coalesce(json_agg(t),\'[]\'::json) FROM (' + sql + ') t; ROLLBACK;')
    return json.loads(raw)

orgs=query("SELECT id,name,edition,send_mode,rollout_scope,live_send_acknowledged,maintenance_mode,platform_status,operational_state,last_successful_sync_at FROM organisations WHERE name='Mott Appliance Repairs'")
if len(orgs) != 1 or orgs[0]['edition'] != 'INTERNAL_LEGACY':
    raise RuntimeError('Exact existing Motts legacy organisation was not uniquely identified')
emit('organisation',orgs)
org=orgs[0]['id']
if not re.fullmatch('[0-9a-f-]{36}',org):
    raise RuntimeError('Invalid organisation ID')
start="'2026-11-20 00:00:00 Australia/Sydney'::timestamptz"
queries={
 'outbox_daily':f"SELECT (created_at AT TIME ZONE 'Australia/Sydney')::date AS local_day,source,status,count(*) n,count(DISTINCT invoice_id) invoices,count(DISTINCT recipient_key) recipients FROM outbound_messages WHERE organisation_id='{org}' AND channel='SMS' AND created_at >= {start} GROUP BY 1,2,3 ORDER BY 1,2,3",
 'cancel_reasons':f"SELECT failure_reason,count(*) n,count(DISTINCT invoice_id) invoices FROM outbound_messages WHERE organisation_id='{org}' AND channel='SMS' AND created_at >= {start} AND status='CANCELLED' GROUP BY 1 ORDER BY 2 DESC",
 'attempts_daily':f"SELECT (a.created_at AT TIME ZONE 'Australia/Sydney')::date AS local_day,a.status,a.error_code,count(*) n,count(a.provider_message_id) provider_ids,count(a.request_dispatched_at) dispatched FROM message_attempts a WHERE organisation_id='{org}' AND provider='SINCH' AND created_at >= {start} GROUP BY 1,2,3 ORDER BY 1,2",
 'last_accepted':f"SELECT max(created_at) last_created,max(completed_at) last_completed,count(*) FILTER(WHERE status='ACCEPTED') accepted,count(*) FILTER(WHERE status='DELIVERED') delivered FROM outbound_messages WHERE organisation_id='{org}' AND channel='SMS' AND status IN ('ACCEPTED','DELIVERED')",
 'stages':f"SELECT origin,channel,status,count(*) n,min(scheduled_at) earliest,max(scheduled_at) latest FROM stage_instances WHERE organisation_id='{org}' AND scheduled_at >= {start} GROUP BY 1,2,3 ORDER BY 1,2,3",
 'approvals':f"SELECT status,count(*) n,min(created_at) earliest,max(decided_at) latest_decision FROM approvals WHERE organisation_id='{org}' AND (created_at >= {start} OR status='PENDING') GROUP BY 1",
 'queued_reminder_evidence':f"SELECT count(*) stages,count(DISTINCT ic.invoice_id) invoices,count(DISTINCT i.contact_id) contacts,count(*) FILTER(WHERE EXISTS(SELECT 1 FROM outbound_messages o WHERE o.stage_instance_id=s.id)) with_outbox,count(*) FILTER(WHERE EXISTS(SELECT 1 FROM message_attempts a JOIN outbound_messages o ON o.id=a.outbound_message_id WHERE o.stage_instance_id=s.id AND a.request_dispatched_at IS NOT NULL)) dispatched FROM stage_instances s JOIN invoice_chases ic ON ic.id=s.invoice_chase_id JOIN invoices i ON i.id=ic.invoice_id WHERE s.organisation_id='{org}' AND s.channel='SMS' AND s.status='QUEUED'",
 'failed_reminder_errors':f"SELECT output->>'message' error,count(*) n FROM pgboss.job WHERE data->>'organisationId'='{org}' AND name='reminder.execute' AND state='failed' GROUP BY 1",
 'sequences':f"SELECT id,name,enabled,mode FROM reminder_sequences WHERE organisation_id='{org}'",
 'sequence_versions':f"SELECT id,sequence_id,version_number,status,send_time,daily_basis,sms_aggregation,social_window_start,social_window_end FROM reminder_sequence_versions WHERE organisation_id='{org}' AND status='ACTIVE'",
 'stages_configuration':f"SELECT s.channel,s.stage_key,s.enabled,s.offset_days FROM sequence_stages s JOIN reminder_sequence_versions v ON v.id=s.sequence_version_id WHERE s.organisation_id='{org}' AND v.status='ACTIVE'",
 'pending_outbound':f"SELECT id,source,status,queued_at,created_at FROM outbound_messages WHERE organisation_id='{org}' AND status IN ('PENDING','QUEUED','SENDING','UNKNOWN') ORDER BY created_at",
 'pending_test_safety':f"SELECT o.id,o.status,o.source,o.recipient_key=ANY(g.recipient_allowlist) destination_allowlisted,(SELECT count(*) FROM message_attempts a WHERE a.outbound_message_id=o.id) attempts FROM outbound_messages o JOIN organisations g ON g.id=o.organisation_id WHERE o.organisation_id='{org}' AND o.source='TEST_SMS' AND o.status='QUEUED'",
 'active_stage_dates':f"SELECT (s.scheduled_at AT TIME ZONE 'Australia/Sydney')::date local_date,(s.scheduled_at AT TIME ZONE 'Australia/Sydney')::time local_time,s.channel,s.status,count(*) n FROM stage_instances s JOIN reminder_sequence_versions v ON v.id=s.sequence_version_id WHERE s.organisation_id='{org}' AND v.status='ACTIVE' GROUP BY 1,2,3,4 ORDER BY 1,2,3,4",
 'fresh_round_candidates':f"SELECT s.channel,s.status,count(*) stages,count(DISTINCT ic.invoice_id) invoices,count(DISTINCT i.contact_id) contacts,min(s.scheduled_at) earliest,max(s.scheduled_at) latest FROM stage_instances s JOIN reminder_sequence_versions v ON v.id=s.sequence_version_id JOIN invoice_chases ic ON ic.id=s.invoice_chase_id JOIN invoices i ON i.id=ic.invoice_id WHERE s.organisation_id='{org}' AND v.status='ACTIVE' AND s.status IN ('SCHEDULED','QUEUED') GROUP BY 1,2 ORDER BY 1,2",
 'recent_job_progress':f"SELECT name,state,count(*) n,max(started_on) latest_start,max(completed_on) latest_complete FROM pgboss.job WHERE data->>'organisationId'='{org}' AND started_on >= '2026-11-27 00:00:00 Australia/Sydney'::timestamptz GROUP BY 1,2 ORDER BY 1,2",
 'recent_job_errors':f"SELECT name,state,output->>'message' error,count(*) n FROM pgboss.job WHERE data->>'organisationId'='{org}' AND started_on >= '2026-11-27 00:00:00 Australia/Sydney'::timestamptz AND state IN ('failed','retry') GROUP BY 1,2,3 ORDER BY 1,2",
 'xero_connection':f"SELECT status,last_refreshed_at,updated_at FROM xero_connections WHERE organisation_id='{org}'",
 'queued_by_version':f"SELECT v.version_number,v.status version_status,s.status,count(*) n FROM stage_instances s JOIN reminder_sequence_versions v ON v.id=s.sequence_version_id WHERE s.organisation_id='{org}' AND s.status IN ('QUEUED','SCHEDULED','SENDING','UNKNOWN') GROUP BY 1,2,3 ORDER BY 1,2,3",
 'queue_columns':"SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='pgboss' AND table_name IN ('job','schedule') ORDER BY table_name,ordinal_position",
 'queues':f"SELECT name,state,count(*) n,min(created_on) earliest,max(created_on) latest FROM pgboss.job WHERE data->>'organisationId'='{org}' GROUP BY 1,2 ORDER BY 1,2",
}
for label,sql in queries.items():
    try:
        emit(label,query(sql))
    except Exception as error:
        emit(label+'_error',str(error))
