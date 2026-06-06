import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';

export function errorHandler(err: Error, c: Context) {
  console.error('[Error]', err.message);

  if (err instanceof HTTPException) {
    return c.json(
      { error: err.message, status: err.status },
      err.status,
    );
  }

  return c.json(
    { error: err.message || 'Internal server error', status: 500 },
    500,
  );
}
