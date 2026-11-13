import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../app/(protected)/inbox/actions.js', () => ({
  sendOperatorReply: vi.fn()
}));

import { ConversationThread } from './conversation-thread.js';

describe('conversation suppression presentation', () => {
  it('explains a provider opt-out without revealing provider plumbing', () => {
    const markup = renderToStaticMarkup(
      <ConversationThread
        organisationId="organisation-1"
        conversationId="conversation-1"
        customerName="Acme Kitchens"
        number="+61412345678"
        messages={[]}
        suppression={{ source: 'SINCH_OPT_OUT', reason: 'STOP reply' }}
      />
    );

    expect(markup).toContain('Customer opt-out');
    expect(markup).toContain('STOP reply');
    expect(markup).not.toContain('Sinch');
    expect(markup).not.toContain('SINCH_OPT_OUT');
  });
});
