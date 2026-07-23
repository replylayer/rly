/**
 * Track 2 (Governed Email-Effect Contract v1) — `rly send --strict` /
 * `rly reply --strict` exit-code mapping shared by both commands.
 *
 * Under `--strict` the command forwards `Prefer: outcome=strict` so the server
 * maps a non-delivered terminal/held outcome to a non-2xx (422 blocked / 409
 * held-for-review / 503 held-infrastructure) carrying the `email_effect` in the
 * error `details`. Without `--strict` the send/reply resolves 200 even on a
 * block (the legacy default) and exit stays 0.
 *
 * This module owns the single source of truth for the strict EXIT codes so the
 * fresh-send throw path AND the probe-FIRST idempotent-replay path (F2) map an
 * identical `effect_status` to an identical exit code.
 *
 * Exit codes (F6 — `EXIT.AUTH` = 3 is already taken; do NOT reuse 3; the `rly`
 * PyPI launcher reserves 124/127/130):
 *   - blocked              → 4   (terminal content rejection — edit/escalate)
 *   - held_infrastructure  → 5   (infra hold / indeterminate dispatch — retry)
 *   - held_for_review      → 0   (releasable by a human — not a failure)
 *   - sent                 → 0   (delivered)
 */
import type { EffectStatus } from '../protocol.js';
import type { ApiError } from '../types.js';

/**
 * Map a governed `effect_status` to the strict-mode process exit code.
 * `sent` and `held_for_review` (human-releasable) and an absent/legacy
 * `email_effect` map to 0; `blocked`→4, `held_infrastructure`→5. An UNKNOWN
 * future `effect_status` fails CLOSED to a nonzero generic exit (6) per the
 * contract's mandatory unknown-enum rule (docs/governed-email-effect.md
 * §Stability) — it must NEVER be silently treated as a `sent` success.
 *
 * Param is widened to `string` (not `EffectStatus`) on purpose: the value comes
 * off the wire and a server running ahead of this CLI can send a member this
 * binary does not yet know — that path MUST be reachable and fail closed.
 */
export function strictExitCodeForEffect(status: string | null | undefined): number {
  switch (status) {
    case 'blocked':
      return 4;
    case 'held_infrastructure':
      return 5;
    case 'sent':
    case 'held_for_review':
      // Known success / human-releasable hold — not a CLI failure.
      return 0;
    case null:
    case undefined:
      // Absent email_effect (older API): the send resolved 200 on the default
      // path — legacy success, not a failure.
      return 0;
    default:
      // Fail-closed: an UNKNOWN future effect_status → nonzero so a scripted
      // agent does not mark the task done on an outcome it cannot interpret.
      // Upgrade `rly` to learn the new member.
      return 6;
  }
}

/**
 * Extract the `effect_status` an ApiError carries in its `details.email_effect`
 * (the strict 4xx/5xx envelope) WITHOUT widening the typed `ApiError.details`
 * shape. Returns undefined when there is no governed effect in the error.
 */
function effectStatusFromApiError(err: ApiError): EffectStatus | undefined {
  const ee = (err.details as { email_effect?: { effect_status?: unknown } } | undefined)
    ?.email_effect;
  const es = ee?.effect_status;
  return typeof es === 'string' ? (es as EffectStatus) : undefined;
}

/**
 * Map a strict-mode ApiError (a 422/409/503 carrying `email_effect` in its
 * details) to its strict exit code; returns `null` when the error is NOT a
 * governed-effect error so the caller falls back to the historical exit code.
 *
 * Self-gating: the server only emits `details.email_effect` on the strict
 * `Prefer: outcome=strict` 4xx/5xx path, so a non-strict caller's errors carry
 * no `email_effect` and are never remapped here.
 */
export function strictApiErrorExitCode(err: ApiError): number | null {
  const status = effectStatusFromApiError(err);
  return status === undefined ? null : strictExitCodeForEffect(status);
}
