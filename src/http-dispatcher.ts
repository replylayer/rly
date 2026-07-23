// packages/cli/src/http-dispatcher.ts
//
// SP-1 (RL-UAT-024/026): the CLI is a short-lived process that should not
// pool keepalive sockets. A lingering keepalive socket left mid-close by the
// global undici agent is what races a synchronous process.exit on Windows and
// triggers `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` (libuv
// src/win/async.c:76, exit -1073740791). Installing an Agent with keepalive
// effectively off closes each socket immediately after its response, so there
// is no lingering handle to race. This is the belt to index.ts's exitCode
// drain (the braces). Best-effort: if undici is unavailable for any reason we
// fall through to the default dispatcher (index.ts's exitCode drain still
// fixes the timing).
import { Agent, setGlobalDispatcher } from 'undici';

try {
  setGlobalDispatcher(
    new Agent({ keepAliveTimeout: 1, keepAliveMaxTimeout: 1 }),
  );
} catch {
  // No-op: keep the default global dispatcher. Layer A (exitCode drain) still
  // resolves the Windows assertion on its own.
}
