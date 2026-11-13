import { describe, expect, it, vi } from 'vitest';

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/headers', () => ({ headers: vi.fn() }));

import * as actions from './actions.js';

describe('customer Xero action boundary', () => {
  it('does not expose SMS-provider configuration actions to customer workspaces', () => {
    expect(Object.keys(actions).sort()).toEqual([
      'disconnectXero',
      'requestXeroSync'
    ]);
  });
});
