import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  usePathname: () => '/platform-admin/retention'
}));

import { PlatformAdminShell } from './platform-admin-shell.js';

describe('platform owner navigation', () => {
  it('links to the retention and privacy operations queue', () => {
    const html = renderToStaticMarkup(
      <PlatformAdminShell displayName="Owner">Content</PlatformAdminShell>
    );

    expect(html).toContain('href="/platform-admin/retention"');
    expect(html).toContain('Retention &amp; privacy');
  });
});
