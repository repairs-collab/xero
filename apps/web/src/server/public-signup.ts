export const isPublicSignupEnabled = (): boolean =>
  process.env.ACCOUNT_PULSE_PUBLIC_SIGNUP_ENABLED === 'true';
