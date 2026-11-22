import type { z } from 'zod';
import { errorSchema } from '@kart/contracts';

export class ApiError extends Error {
  constructor(message: string, public readonly status: number) { super(message); }
}
let csrf: string | undefined;
export function setCsrf(value?: string) { csrf = value; }
export async function api<T>(path: string, schema: z.ZodType<T>, options: {
  method?: string; body?: unknown; key?: string;
} = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      method: options.method ?? 'GET', credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
        ...(options.key ? { 'Idempotency-Key': options.key } : {}),
      },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });
  } catch { throw new ApiError('Cannot reach Kart. Check your connection and retry.', 0); }
  const data: unknown = await response.json().catch(() => { throw new ApiError('Unexpected server response. Please retry.', response.status); });
  if (!response.ok) {
    const error = errorSchema.safeParse(data);
    throw new ApiError(error.success ? error.data.message : 'Request failed. Please retry.', response.status);
  }
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new ApiError('Kart received an invalid response. Please reload.', 502);
  return parsed.data;
}
