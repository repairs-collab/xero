const httpsUrlOrNull = (value: string | undefined): string | null => {
  if (value === undefined || value.trim() === '') return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
};

export const legalIdentity = () => ({
  entity:
    process.env.ACCOUNT_PULSE_LEGAL_ENTITY?.trim() ||
    'Swan Hill Appliance Repairs Pty Ltd',
  supportEmail:
    process.env.ACCOUNT_PULSE_SUPPORT_EMAIL?.trim() || 'AP@motts.com.au',
  supportChatUrl: httpsUrlOrNull(
    process.env.ACCOUNT_PULSE_SUPPORT_CHAT_URL
  )
});

export const legalLastUpdated = '11 November 2026';
export const termsLastUpdated = '12 November 2026';
