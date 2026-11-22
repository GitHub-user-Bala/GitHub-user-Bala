import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().url().refine(value => /^postgres(ql)?:\/\//.test(value), 'Use a PostgreSQL connection URL.'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  WEB_ORIGIN: z.string().url().refine(value => new URL(value).origin === value, 'Use an origin without a trailing slash or path.').default('http://localhost:5173'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  SENTRY_DSN: z.string().url().optional().or(z.literal('')),
}).refine(v => Boolean(v.GOOGLE_CLIENT_ID) === Boolean(v.GOOGLE_CLIENT_SECRET), {
  message: 'Configure both Google client ID and secret, or neither.',
}).refine(v => v.NODE_ENV !== 'production' || v.WEB_ORIGIN.startsWith('https://'), {
  message: 'Production WEB_ORIGIN requires HTTPS.',
});
export const config = schema.parse(process.env);
export const googleEnabled = Boolean(config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET);
export const cookieName = config.NODE_ENV === 'production' ? '__Host-kart' : 'kart';
