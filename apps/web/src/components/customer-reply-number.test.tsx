import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { CustomerReplyNumber } from './customer-reply-number.js';

describe('customer reply number', () => {
  it('shows a ready AccountPulse number without provider details', () => {
    const markup = renderToStaticMarkup(
      <CustomerReplyNumber
        number={{ e164Number: '+61412345678', status: 'READY' }}
      />
    );

    expect(markup).toContain('+61 412 345 678');
    expect(markup).toContain('AccountPulse reply number');
    expect(markup).toContain('Ready for replies');
    expect(markup).not.toContain('Sinch');
    expect(markup).not.toContain('provider');
    expect(markup).not.toContain('<form');
    expect(markup).not.toContain('<button');
  });

  it('shows shared SMS routing for a linked workspace', () => {
    const markup = renderToStaticMarkup(
      <CustomerReplyNumber number={null} sharedSmsReady />
    );

    expect(markup).toContain('Shared SMS numbers');
    expect(markup).toContain('Replies to your messages appear in your workspace inbox.');
    expect(markup).not.toContain('being prepared');
    expect(markup).not.toContain('Sinch');
    expect(markup).not.toContain('+61');
  });

  it('explains provisioning without inventing a number', () => {
    const markup = renderToStaticMarkup(<CustomerReplyNumber number={null} />);

    expect(markup).toContain('SMS setup is pending');
    expect(markup).not.toContain('+61');
    expect(markup).not.toContain('<form');
    expect(markup).not.toContain('<button');
  });
});
