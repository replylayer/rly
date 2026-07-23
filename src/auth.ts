import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { LocalCliError } from './errors.js';

export type KeySource = 'flag' | 'env' | 'file' | 'none';

export interface ResolvedKey {
  apiKey: string | null;
  source: KeySource;
}

function credentialsDir(): string {
  return path.join(os.homedir(), '.replylayer');
}

function credentialsFile(): string {
  return path.join(credentialsDir(), 'credentials');
}

/**
 * Resolve the API key using the priority order:
 * 1. --api-key flag (passed explicitly)
 * 2. REPLYLAYER_API_KEY environment variable
 * 3. ~/.replylayer/credentials file
 */
export function resolveApiKey(flagValue?: string): ResolvedKey {
  if (flagValue) {
    return { apiKey: flagValue, source: 'flag' };
  }

  const envKey = process.env['REPLYLAYER_API_KEY'];
  if (envKey) {
    return { apiKey: envKey, source: 'env' };
  }

  const fileKey = readCredentialFile();
  if (fileKey) {
    return { apiKey: fileKey, source: 'file' };
  }

  return { apiKey: null, source: 'none' };
}

/**
 * Read the API key from the credential file.
 */
export function readCredentialFile(): string | null {
  try {
    const content = fs.readFileSync(credentialsFile(), 'utf-8').trim();
    return content || null;
  } catch {
    return null;
  }
}

/**
 * Store an API key in the credential file with 0600 permissions.
 */
export function storeApiKey(apiKey: string): void {
  const dir = credentialsDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  fs.writeFileSync(credentialsFile(), apiKey + '\n', { mode: 0o600 });
}

/**
 * Delete the credential file (logout).
 */
export function deleteCredentialFile(): boolean {
  try {
    fs.unlinkSync(credentialsFile());
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the path to the credential file (for display purposes).
 */
export function getCredentialFilePath(): string {
  return credentialsFile();
}

/**
 * Require an API key or exit with an error message.
 */
export function requireApiKey(flagValue?: string): string {
  const { apiKey } = resolveApiKey(flagValue);
  if (!apiKey) {
    throw new LocalCliError(
      'No API key configured.',
      'API_KEY_REQUIRED',
    );
  }
  return apiKey;
}
