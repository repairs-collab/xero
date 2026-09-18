import { z } from 'zod';

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']),
    DATABASE_URL: z.string().url(),
    AWS_REGION: z.literal('ap-southeast-2'),
    SEND_MODE: z.enum(['dry-run', 'live']).default('dry-run'),
    LIVE_SEND_ACK: z
      .literal('I_UNDERSTAND_CUSTOMERS_WILL_BE_CONTACTED')
      .optional()
  })
  .superRefine((value, context) => {
    if (
      value.SEND_MODE === 'live' &&
      value.LIVE_SEND_ACK !== 'I_UNDERSTAND_CUSTOMERS_WILL_BE_CONTACTED'
    ) {
      context.addIssue({
        code: 'custom',
        path: ['LIVE_SEND_ACK'],
        message: 'LIVE_SEND_ACK is required for live sending'
      });
    }
  });

export type RuntimeEnv = z.infer<typeof schema>;

export const parseRuntimeEnv = (
  input: Record<string, string | undefined>
): RuntimeEnv => schema.parse(input);
