import type { Request } from 'express';

export const DEFAULT_HTTP_JSON_BODY_LIMIT = '20mb';

export function isSignedPaymentWebhookPath(path: string): boolean {
  const normalized = String(path || '').split('?')[0].replace(/\/+$/, '');
  return /\/payments\/callbacks\/[^/]+\/[^/]+$/.test(normalized);
}

export function captureRawBody(req: Request & { rawBody?: Buffer }, _res: unknown, buffer: Buffer): void {
  if (buffer?.length) {
    req.rawBody = buffer;
  }
}
