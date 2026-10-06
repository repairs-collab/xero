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
  it('uses AccountPulse as the accessible product identity', () => {
    const html = renderToStaticMarkup(
      createElement(AppShell, {
        displayName: 'Mott Appliance Repairs Admin',
        role: 'ADMIN',
        children: createElement('p', null, 'Dashboard')
      })
    );

    expect(html).toContain('aria-label="AccountPulse overview"');
    expect(html).toContain('src="/accountpulse-logo.png"');
    expect(html).toContain('alt="AccountPulse"');
    expect(html).not.toContain('Bill Chaser 5000');
  });

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

  it('places Outbox immediately after Inbox in primary navigation', () => {
    const html = renderToStaticMarkup(
      createElement(AppShell, {
        displayName: 'Mott Appliance Repairs Admin',
        role: 'ADMIN',
        children: createElement('p', null, 'Dashboard')
      })
    );

    const inbox = html.indexOf('href="/inbox"');
    const outbox = html.indexOf('href="/outbox"');
    const escalations = html.indexOf('href="/escalations"');
    expect(inbox).toBeGreaterThan(-1);
    expect(outbox).toBeGreaterThan(inbox);
    expect(escalations).toBeGreaterThan(outbox);
  });

  it('provides a top-bar search for invoices, customers, and amounts', () => {
    const html = renderToStaticMarkup(
      createElement(AppShell, {
        displayName: 'Mott Appliance Repairs Admin',
        role: 'ADMIN',
        children: createElement('p', null, 'Dashboard')
      })
    );

    expect(html).toContain('action="/search"');
    expect(html).toContain('name="q"');
    expect(html).toContain('type="search"');
    expect(html).toContain('Search invoices, customers or amounts');
  });
});
