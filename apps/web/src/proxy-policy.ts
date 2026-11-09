const publicExactPaths = new Set([
  '/account-recovery',
  '/api/webhooks/xero',
  '/api/webhooks/sinch',
  '/api/webhooks/stripe',
  '/auth/callback',
  '/auth/login',
  '/auth/logout',
  '/health/live',
  '/health/ready',
  '/start',
  '/favicon.ico'
]);

export const isPublicPath = (pathname: string): boolean =>
  publicExactPaths.has(pathname) ||
  pathname.startsWith('/_next/') ||
  pathname.startsWith('/static/');

export function evaluateProxyAccess(
  pathname: string,
  hasSessionCookie: boolean
): 'allow' | 'login' {
  return isPublicPath(pathname) || hasSessionCookie ? 'allow' : 'login';
}
