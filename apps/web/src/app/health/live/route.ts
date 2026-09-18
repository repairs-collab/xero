import { NextResponse } from 'next/server';

export function GET() {
  return NextResponse.json(
    { service: 'bill-chaser-5000-web', status: 'ok' },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}
