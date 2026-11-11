import Link from 'next/link';
import type { ReactNode } from 'react';

import { legalIdentity } from '../../server/legal-content.js';

export default function LegalLayout({ children }: { children: ReactNode }) {
  const legal = legalIdentity();
  return (
    <main className="public-page legal-page" id="main-content">
      <article className="public-card legal-document">{children}</article>
      <footer className="legal-footer">
        <Link href="/legal/terms">Terms</Link>
        <Link href="/legal/privacy">Privacy</Link>
        <Link href="/legal/acceptable-use">Acceptable use</Link>
        <a href={`mailto:${legal.supportEmail}`}>Support</a>
      </footer>
    </main>
  );
}
