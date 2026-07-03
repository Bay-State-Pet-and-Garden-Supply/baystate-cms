/**
 * Extraction Worker Auth
 *
 * Reads the worker token from environment and validates incoming
 * `Authorization: Bearer <token>` headers.
 *
 * The server fails closed: if `SHOPSITE_CMS_WORKER_TOKEN` is not set,
 * all requests are rejected with 401.
 */

import type { IncomingMessage } from 'node:http';

function getToken(): string | null {
  const token = process.env.SHOPSITE_CMS_WORKER_TOKEN;
  return token && token.length > 0 ? token : null;
}

export interface AuthResult {
  authorized: boolean;
  message?: string;
}

/**
 * Check whether the given request carries a valid bearer token.
 *
 * When no token is configured, all requests are rejected (fail closed).
 */
export function checkAuth(req: IncomingMessage): AuthResult {
  const token = getToken();

  if (!token) {
    return { authorized: false, message: 'Server authentication is not configured' };
  }

  const authHeader = req.headers['authorization'];

  if (!authHeader) {
    return { authorized: false, message: 'Missing Authorization header' };
  }

  if (!authHeader.startsWith('Bearer ')) {
    return { authorized: false, message: 'Authorization header must use Bearer scheme' };
  }

  const providedToken = authHeader.slice('Bearer '.length).trim();

  if (providedToken !== token) {
    return { authorized: false, message: 'Invalid bearer token' };
  }

  return { authorized: true };
}
