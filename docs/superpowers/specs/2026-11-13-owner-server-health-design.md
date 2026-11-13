# AccountPulse Owner Server Health Design

## Intent

Give the AccountPulse platform Owner a safe, read-only view of OVH host capacity and core application health so upgrades can be planned before disk, memory, load, or service failures affect customers.

## Scope

- Add a **Server health** page under the private `/platform-admin` owner console.
- Show snapshot age, uptime, CPU load, memory, disk, and core service states.
- Grade the snapshot as healthy, warning, critical, or unavailable with visible thresholds.
- Keep the page behind the existing platform `OWNER` authorization boundary.
- Collect metrics on the OVH host and publish only a sanitized JSON snapshot to the web container through a read-only mount.

## Non-goals and anti-goals

- No customer-workspace or customer-administrator access.
- No live shell, command execution, container control, restart button, or write action from the web app.
- No Docker socket in the web container.
- No hostname, IP address, filesystem path, environment value, credential, process command line, customer data, or provider secret in the snapshot or UI.
- No remote monitoring vendor or paid service.

## Approaches considered

1. **Sanitized host snapshot (chosen).** A root-owned timer runs a small collector on OVH, writes an atomic JSON snapshot, and exposes only that file to the web container read-only. This is the smallest attack surface and still reports real host and container health.
2. **Mount the Docker socket into the web app (rejected).** It makes live container data easy to query but effectively grants host-level control to a public-facing process.
3. **Deploy a remote monitoring agent and API (deferred).** It can add alerting and history later, but introduces another service, credential, cost, and network boundary before the beta needs them.

## Data contract

Schema version 1 contains only:

- UTC `checkedAt`
- host uptime seconds, CPU core count, and 1/5/15-minute load averages
- total/used/free memory bytes
- total/used/free root-disk bytes
- fixed core services (`web`, `worker`, `postgres`, `caddy`) with `HEALTHY`, `STARTING`, `UNHEALTHY`, or `DOWN`

Unknown fields and unapproved service names are discarded by the web reader.

## Health rules

- Snapshot older than 15 minutes: unavailable.
- Disk or memory at 90% or more, any core service unhealthy/down, or 5-minute load at 150% or more of CPU cores: critical.
- Disk or memory at 80% or more, any service starting, or 5-minute load at 100% or more of CPU cores: warning.
- Otherwise: healthy.
- Missing, malformed, or unreadable snapshot: unavailable, with no internal error details rendered.

## Deployment

The collector writes to `/var/lib/accountpulse/server-health/server-health.json` atomically. Compose mounts the directory at `/run/accountpulse-server-health:ro` in the web container and points `SERVER_HEALTH_SNAPSHOT_PATH` at the file. A systemd timer refreshes the snapshot every five minutes. Installation is explicit and does not start or mutate customer messaging.

