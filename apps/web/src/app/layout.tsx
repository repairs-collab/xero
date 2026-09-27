import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import './globals.css';

export const metadata: Metadata = {
  title: 'AccountPulse',
  description: 'Accounts receivable reminders and collection workflows for Mott Appliance Repairs.'
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en-AU">
      <body><a className="skip-link" href="#main-content">Skip to content</a>{children}</body>
    </html>
  );
}
