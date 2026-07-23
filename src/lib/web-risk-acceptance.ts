/**
 * GENERATED FILE - do not edit by hand.
 *
 * Synced from the private monorepo's web-risk notice + constants. This published
 * mirror carries no private dependency; regenerate with the monorepo tooling.
 *
 * Update with: pnpm generate:notices
 * Check with: pnpm check:notices
 *
 * The published CLI does not depend on the private monorepo at runtime, so this
 * notice is mirrored into the CLI package and hand-synced from the canonical source
 * so the signup copy cannot drift silently.
 */

export const CURRENT_URL_REPUTATION_DISCLAIMER_VERSION = 'v2';

export const WEB_RISK_ADVISORY_URL = 'https://cloud.google.com/web-risk/docs/advisory';

export const WEB_RISK_NOTICE =
  'ReplyLayer uses automated safety screening, including AI models, rules-based ' +
  'scanners, and malware and abuse checks, to help detect phishing, malware, ' +
  'prompt injection, data leakage, abuse, and other policy or security risks in ' +
  'inbound and outbound email. These systems are imperfect: they may miss risks ' +
  'and may incorrectly flag legitimate messages. Review flagged messages before ' +
  'releasing, blocking, or acting on them. URL reputation is powered by Google ' +
  'Web Risk. Protection is imperfect — Web Risk may miss some threats (false ' +
  'negatives) and may occasionally flag legitimate URLs (false positives). Review ' +
  'flagged messages before acting.';
