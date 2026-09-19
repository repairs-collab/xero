import { sql } from 'drizzle-orm';
import { NextResponse } from 'next/server';

import { getDatabaseClient } from '../../../server/runtime.js';

export async function GET() {
  try {
    await getDatabaseClient().db.execute(sql`select 1`);
    return NextResponse.json(
      { service: 'bill-chaser-5000-web', status: 'ready' },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch {
    return NextResponse.json(
      { service: 'bill-chaser-5000-web', status: 'unavailable' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}
