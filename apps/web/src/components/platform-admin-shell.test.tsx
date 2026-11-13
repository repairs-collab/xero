import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  usePathname: () => '/platform-admin/retention'
}));

import { PlatformAdminShell } from './platform-admin-shell.js';

describe('platform owner navigation', () => {
  it('links to retention operations and the owner-only server health HUD', () => {
    const html = renderToStaticMarkup(
      <PlatformAdminShell displayName="Owner">Content</PlatformAdminShell>
    );

    expect(html).toContain('href="/platform-admin/retention"');
    expect(html).toContain('Retention &amp; privacy');
    expect(html).toContain('href="/platform-admin/system"');
    expect(html).toContain('Server health');
  });
});
