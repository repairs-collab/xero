import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/link', () => ({
  default: ({
    children,
    href,
    prefetch,
    ...props
  }: {
    children: ReactNode;
    href: string;
    prefetch?: boolean;
  }) =>
    createElement('a', {
      ...props,
      href,
      'data-prefetch': String(prefetch),
      children
    })
}));

vi.mock('next/navigation', () => ({
  usePathname: () => '/'
}));

import { AppShell } from '../src/components/app-shell.js';

describe('AppShell', () => {
  it('does not prefetch the state-changing sign-out route', () => {
    const html = renderToStaticMarkup(
      createElement(AppShell, {
        displayName: 'Mott Appliance Repairs Admin',
        role: 'ADMIN',
        children: createElement('p', null, 'Dashboard')
      })
    );

    expect(html).toContain('href="/auth/logout"');
    expect(html).toContain('data-prefetch="false"');
  });
});
