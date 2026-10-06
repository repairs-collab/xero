import { describe, expect, it } from 'vitest';

import {
  parseCustomerSort
} from '../src/server/customer-list-service.js';
import {
  normaliseSearchAmount
} from '../src/server/global-search-service.js';

describe('customer list sorting', () => {
  it('defaults invalid values to name ascending', () => {
    expect(parseCustomerSort(undefined, undefined)).toEqual({
      sort: 'name',
      direction: 'asc'
    });
    expect(parseCustomerSort('drop table', 'sideways')).toEqual({
      sort: 'name',
      direction: 'asc'
    });
  });

  it('accepts only the supported sort fields and directions', () => {
    expect(parseCustomerSort('email', 'desc')).toEqual({
      sort: 'email',
      direction: 'desc'
    });
    expect(parseCustomerSort('invoices', 'asc')).toEqual({
      sort: 'invoices',
      direction: 'asc'
    });
    expect(parseCustomerSort('amount', 'desc')).toEqual({
      sort: 'amount',
      direction: 'desc'
    });
  });
});

describe('global search amount parsing', () => {
  it('normalises Australian currency input for exact amount matching', () => {
    expect(normaliseSearchAmount('$61,186.33')).toBe('61186.3300');
    expect(normaliseSearchAmount('  250 ')).toBe('250.0000');
    expect(normaliseSearchAmount('invoice 250')).toBeNull();
    expect(normaliseSearchAmount('-1')).toBeNull();
  });
});
