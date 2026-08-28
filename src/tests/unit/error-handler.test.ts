import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { HTTPException } from 'hono/http-exception';
import type { Context } from 'hono';
import { errorHandler } from '../../server/middleware/error-handler';

describe('errorHandler middleware', () => {
  const originalEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
  });

  function mockContext() {
    let jsonResult: { data: unknown; status: number } | undefined;
    const c = {
      json: (data: unknown, status: number) => {
        jsonResult = { data, status };
        return jsonResult;
      },
    } as unknown as Context;
    return { c, getResult: () => jsonResult };
  }

  it('handles HTTPException by preserving the status and message', () => {
    const { c, getResult } = mockContext();
    const httpErr = new HTTPException(400, { message: 'Invalid payload' });

    errorHandler(httpErr, c);

    expect(getResult()).toEqual({
      data: { error: 'Invalid payload', status: 400 },
      status: 400,
    });
  });

  it('hides internal error details in production / test mode', () => {
    process.env.NODE_ENV = 'production';
    const { c, getResult } = mockContext();
    const internalErr = new Error('SQLITE_ERROR: table users has no column named password_hash at secret_query.ts:42');

    errorHandler(internalErr, c);

    expect(getResult()).toEqual({
      data: { error: 'Internal server error', status: 500 },
      status: 500,
    });
  });

  it('exposes internal error details when NODE_ENV is development', () => {
    process.env.NODE_ENV = 'development';
    const { c, getResult } = mockContext();
    const devErr = new Error('Detailed debug info for dev');

    errorHandler(devErr, c);

    expect(getResult()).toEqual({
      data: { error: 'Detailed debug info for dev', status: 500 },
      status: 500,
    });
  });
});
