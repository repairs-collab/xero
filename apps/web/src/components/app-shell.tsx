'use client';

import {
  ArrowRightStartOnRectangleIcon,
  BoltIcon,
  BuildingOffice2Icon,
  ChatBubbleLeftRightIcon,
  CheckCircleIcon,
  ClockIcon,
  Cog6ToothIcon,
  ExclamationTriangleIcon,
  HomeIcon,
  PaperAirplaneIcon,
  UserGroupIcon
} from '@heroicons/react/24/outline';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

const navigation = [
  ['Overview', '/', HomeIcon],
  ['Approvals', '/approvals', CheckCircleIcon],
  ['Inbox', '/inbox', ChatBubbleLeftRightIcon],
  ['Outbox', '/outbox', PaperAirplaneIcon],
  ['Escalations', '/escalations', ExclamationTriangleIcon],
  ['Customers', '/customers', UserGroupIcon],
  ['Sequences', '/sequences', BoltIcon],
  ['Activity', '/activity', ClockIcon]
] as const;

const isActivePath = (pathname: string, href: string) =>
  pathname === href || (href !== '/' && pathname.startsWith(`${href}/`));

export function AppShell({
  children,
  displayName,
  role,
  organisationName = 'Mott Appliance Repairs'
}: {
  children: ReactNode;
  displayName: string;
  role: 'ADMIN' | 'OPERATOR';
  organisationName?: string;
}) {
  const pathname = usePathname();
  const initials = displayName.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase();

  return (
    <div className="app-shell">
      <header className="app-header">
        <Link href="/" className="brand" aria-label="AccountPulse overview">
          <img src="/accountpulse-logo.png" alt="AccountPulse" width="318" height="106" />
        </Link>

        <div className="workspace-switcher" aria-label={`Current workspace: ${organisationName}`}>
          <BuildingOffice2Icon aria-hidden="true" />
          <span><small>Workspace</small><strong>{organisationName}</strong></span>
        </div>

        <div className="account-menu">
          <span className="avatar">{initials || 'MA'}</span>
          <span className="account-menu__copy">
            <strong>{displayName}</strong>
            <small>{role === 'ADMIN' ? 'Administrator' : 'Operator'}</small>
          </span>
          <Link href="/auth/logout" prefetch={false} aria-label="Sign out" className="signout">
            <ArrowRightStartOnRectangleIcon aria-hidden="true" />
          </Link>
        </div>
      </header>

      <nav className="app-nav" aria-label="Primary navigation">
        <div className="app-nav__inner">
          {navigation.map(([label, href, Icon]) => (
            <Link href={href} key={label} className={`nav-item ${isActivePath(pathname, href) ? 'nav-item--active' : ''}`}>
              <Icon aria-hidden="true" />
              <span>{label}</span>
            </Link>
          ))}
          {role === 'ADMIN' && (
            <Link href="/settings" className={`nav-item nav-item--settings ${isActivePath(pathname, '/settings') ? 'nav-item--active' : ''}`}>
              <Cog6ToothIcon aria-hidden="true" />
              <span>Admin Settings</span>
            </Link>
          )}
        </div>
      </nav>

      <main className="content" id="main-content">{children}</main>
    </div>
  );
}
