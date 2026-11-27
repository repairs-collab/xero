import { EmailDeliveryMonitor } from '../../../components/platform-admin/email-delivery-monitor.js';
import { getPlatformEmailMonitoringService } from '../../../server/platform-email-monitoring-service.js';
import { requirePlatformOwnerPage } from '../../../server/platform-page-authorization.js';

export default async function PlatformEmailPage() {
  const session = await requirePlatformOwnerPage('/platform-admin/email');
  const snapshot = await getPlatformEmailMonitoringService().getSnapshot(
    session.userId
  );
  return <EmailDeliveryMonitor snapshot={snapshot} />;
}
