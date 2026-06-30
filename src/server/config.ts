import crypto from 'node:crypto';
import { z } from 'zod';

const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).optional().default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),
  APP_BASE_URL: z.string().url().optional().default('http://localhost:3000'),
  JUNIMO_BASE_URL: z.string().url(),
  JUNIMO_MAP_BASE_URL: z.string().url().optional(), // Optional fallback to JUNIMO_BASE_URL
  JUNIMO_API_KEY: z.string().min(1),
  ADMIN_PASSWORD: z.string().min(12),
  SESSION_SECRET: z.string().min(32).optional(),
  SESSION_TTL_HOURS: z.coerce.number().int().positive().default(12),
  TRUST_PROXY: z
    .union([z.literal('true'), z.literal('false')])
    .optional()
    .transform((value) => value === 'true'),
  LOGIN_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(15 * 60 * 1000),
  LOGIN_RATE_LIMIT_MAX_ATTEMPTS: z.coerce.number().int().positive().default(6),
  ACTION_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60 * 1000),
  ACTION_RATE_LIMIT_MAX_ATTEMPTS: z.coerce.number().int().positive().default(30),
});

export type AppConfig = z.infer<typeof configSchema> & {
  sessionSecret: string;
  allowedOrigins: string[];
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = configSchema.parse(env);
  const appOrigin = new URL(parsed.APP_BASE_URL).origin;
  const allowedOrigins =
    parsed.NODE_ENV === 'development'
      ? Array.from(new Set([appOrigin, 'http://127.0.0.1:5173', 'http://localhost:5173']))
      : [appOrigin];

  return {
    ...parsed,
    sessionSecret:
      parsed.SESSION_SECRET ?? crypto.createHash('sha256').update(parsed.ADMIN_PASSWORD).digest('hex'),
    allowedOrigins,
  };
}
