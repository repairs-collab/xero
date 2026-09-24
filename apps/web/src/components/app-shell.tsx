'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

const navigation = [
  ['Overview', '/', '⌂'],
  ['Approvals', '/approvals', '✓'],
  ['Inbox', '/inbox', '✉'],
  ['Escalations', '/escalations', '!'],
  ['Customers', '/customers', '♙'],
  ['Sequences', '/sequences', '↯'],
  ['Activity', '/activity', '↺'],
  ['Admin Settings', '/settings', '⚙']
] as const;

export function AppShell({
  children,
  displayName,
  role,
  organisationName = 'Bill Chaser 5000'
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
      <aside className="sidebar">
        <Link href="/" className="brand" aria-label="Bill Chaser 5000 overview">
          <span className="brand__mark">B5</span>
          <span><strong>Bill Chaser</strong><small>5000</small></span>
        </Link>
        <nav aria-label="Primary navigation">
          <span className="nav-label">Workspace</span>
          {navigation.slice(0, 7).map(([label, href, icon]) => (
            <Link href={href} key={label} className={`nav-item ${pathname === href || (href !== '/' && pathname.startsWith(`${href}/`)) ? 'nav-item--active' : ''}`}><span aria-hidden="true">{icon}</span>{label}</Link>
          ))}
          {role === 'ADMIN' && (
            <>
              <span className="nav-label nav-label--settings">Configuration</span>
              {navigation.slice(7).map(([label, href, icon]) => (
                <Link href={href} key={label} className={`nav-item ${pathname === href || pathname.startsWith(`${href}/`) ? 'nav-item--active' : ''}`}><span aria-hidden="true">{icon}</span>{label}</Link>
              ))}
            </>
          )}
        </nav>
        <div className="sidebar__footer">
          <div className="avatar">{initials || 'BC'}</div>
          <div><strong>{displayName}</strong><small>{role === 'ADMIN' ? 'Administrator' : 'Operator'} · {organisationName}</small></div>
          <Link href="/auth/logout" prefetch={false} aria-label="Sign out" className="signout">↗</Link>
        </div>
      </aside>
      <main className="content" id="main-content">{children}</main>
    </div>
  );
}
