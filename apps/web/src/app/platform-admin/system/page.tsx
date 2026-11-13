import { ServerHealthHud } from '../../../components/platform-admin/server-health-hud.js';
import { requirePlatformOwnerPage } from '../../../server/platform-page-authorization.js';
import { loadServerHealthSnapshot } from '../../../server/server-health.js';

export default async function PlatformServerHealthPage() {
  await requirePlatformOwnerPage('/platform-admin/system');
  const health = await loadServerHealthSnapshot();
  return <ServerHealthHud health={health} />;
}

