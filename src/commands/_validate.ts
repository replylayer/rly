import { LocalCliError } from '../errors.js';

/**
 * Full-string non-negative-integer option guard (N2 / S2).
 *
 * The canonical `Number.parseInt(raw, 10)` + `Number.isFinite` shape used
 * elsewhere SILENTLY ACCEPTS partial inputs: `Number.parseInt('10abc', 10)`
 * is `10`, `Number.parseInt('1.5', 10)` is `1`, so `--limit 10abc` / `--limit
 * 1.5` would coerce to a truncated integer instead of failing. This guard
 * validates the WHOLE string with `/^\d+$/` (after rejecting any surrounding
 * whitespace) before parsing, so `''`, `'10abc'`, `'1.5'`, `'-3'`, `' 5'`,
 * `'0x1f'`, and `'1e3'` all fail `INVALID_OPTION` (exit 2) rather than
 * partial-coercing. Range is then enforced against the server-side cap.
 *
 * Must be called BEFORE any network call (a bad numeric flag is a pure
 * client-side error and fails network-free).
 */
export function parseIntOption(raw: string, flag: string, min: number, max: number): number {
  const failed = (): never => {
    throw new LocalCliError(
      `${flag} must be an integer between ${min} and ${max}`,
      'INVALID_OPTION',
      { option: flag, value: raw },
      2,
    );
  };

  // Reject surrounding whitespace and any non-digit content (the full-string rule).
  if (raw.trim() !== raw || !/^\d+$/.test(raw)) failed();

  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < min || n > max) failed();

  return n;
}
