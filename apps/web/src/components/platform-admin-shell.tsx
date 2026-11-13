'use client';

import {
  ArrowRightStartOnRectangleIcon,
  ArchiveBoxIcon,
  BanknotesIcon,
  BuildingOffice2Icon,
  ChatBubbleLeftRightIcon,
  ClipboardDocumentListIcon,
  HomeIcon,
  ServerStackIcon,
  ShieldCheckIcon
} from '@heroicons/react/24/outline';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

const navigation = [
  ['Overview', '/platform-admin', HomeIcon],
  ['Customers', '/platform-admin#customers', BuildingOffice2Icon],
  ['Billing operations', '/platform-admin/billing', BanknotesIcon],
  ['Retention & privacy', '/platform-admin/retention', ArchiveBoxIcon],
  ['Sinch & SMS', '/platform-admin/sms', ChatBubbleLeftRightIcon],
  ['Server health', '/platform-admin/system', ServerStackIcon],
  ['Audit', '/platform-admin/audit', ClipboardDocumentListIcon]
] as const;

const isActivePath = (pathname: string, href: string) => {
  const path = href.split('#')[0] ?? href;
  return pathname === path || (path !== '/platform-admin' && pathname.startsWith(`${path}/`));
};

export function PlatformAdminShell({
  children,
  displayName
}: {
  children: ReactNode;
  displayName: string;
}) {
  const pathname = usePathname();
  const initials = displayName
    .split(/\s+/)
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

  return (
    <div className="app-shell platform-admin-shell">
      <header className="app-header">
        <Link href="/platform-admin" className="brand" aria-label="AccountPulse owner overview">
          <img src="/accountpulse-logo.png" alt="AccountPulse" width="318" height="106" />
        </Link>
        <div className="workspace-switcher" aria-label="Platform owner console">
          <ShieldCheckIcon aria-hidden="true" />
          <span><small>Private console</small><strong>AccountPulse Owner</strong></span>
        </div>
        <div className="account-menu">
          <span className="avatar">{initials || 'AP'}</span>
          <span className="account-menu__copy">
            <strong>{displayName}</strong>
            <small>Platform owner</small>
          </span>
          <Link href="/auth/logout" prefetch={false} aria-label="Sign out" className="signout">
            <ArrowRightStartOnRectangleIcon aria-hidden="true" />
          </Link>
        </div>
      </header>
      <nav className="app-nav" aria-label="Owner navigation">
        <div className="app-nav__inner">
          {navigation.map(([label, href, Icon]) => (
            <Link
              href={href}
              key={label}
              className={`nav-item ${isActivePath(pathname, href) ? 'nav-item--active' : ''}`}
            >
              <Icon aria-hidden="true" />
              <span>{label}</span>
            </Link>
          ))}
        </div>
      </nav>
      <main className="content" id="main-content">{children}</main>
    </div>
  );
}
