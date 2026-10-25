import { createHash } from 'node:crypto';
import { AppError } from './domain';
import type { Step } from './types';

export const MAX_DIAGNOSTIC_BYTES = 4096;
export function outputDiagnostic(text: string, secrets: string[] = []) {
  for (const secret of secrets) if (secret) text = text.split(secret).join('[redacted]');
  text = text
    .replace(/Bearer\s+[^\s"\\]+/gi, 'Bearer [redacted]')
    .replace(/\b(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]+/g, '[redacted]');
  const bytes = Buffer.from(text, 'utf8');
  // Decode a complete UTF-8 prefix so replacement characters cannot exceed the cap.
  let end = Math.min(bytes.length, MAX_DIAGNOSTIC_BYTES);
  while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
  return {
    excerpt: bytes.subarray(0, end).toString('utf8'),
    bytes: bytes.length,
    truncated: end < bytes.length,
    hash: createHash('sha256').update(bytes).digest('hex'),
  };
}

export type CallAudit = Pick<Step, 'usage' | 'cost' | 'requestId' | 'diagnostic'>;
export class ModelOutputError extends AppError {
  constructor(
    error: AppError,
    public audit: CallAudit,
  ) {
    super(error.code, error.message, error.status);
  }
}
