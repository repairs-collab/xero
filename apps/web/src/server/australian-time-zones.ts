export const australianTimeZones = [
  'Australia/Sydney',
  'Australia/Melbourne',
  'Australia/Hobart',
  'Australia/Brisbane',
  'Australia/Adelaide',
  'Australia/Darwin',
  'Australia/Perth',
  'Australia/Lord_Howe'
] as const;

export type AustralianTimeZone = (typeof australianTimeZones)[number];

const supportedAustralianTimeZones = new Set<string>(australianTimeZones);

export const isAustralianTimeZone = (
  value: string
): value is AustralianTimeZone => supportedAustralianTimeZones.has(value);
