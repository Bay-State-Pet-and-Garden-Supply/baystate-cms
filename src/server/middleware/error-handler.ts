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

  // Do not leak internal error details (e.g. database errors, stack traces) in production
  const isDev = process.env.NODE_ENV === 'development';
  const errorMessage = isDev && err.message ? err.message : 'Internal server error';

  return c.json(
    { error: errorMessage, status: 500 },
    500,
  );
}
