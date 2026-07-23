# Security policy

Report security issues **privately** to <security@replylayer.ai>. Please do not
open public issues for vulnerabilities.

The canonical machine-readable contact is published at
<https://replylayer.net/.well-known/security.txt> (RFC 9116).

What helps us act fast: the affected surface (CLI version and install channel —
npm / PyPI / winget), reproduction steps, and impact. `rly --version` reports
the version of the executable that actually ran.

Release integrity questions (signatures, checksums, provenance) are covered in
[`TRUST.md`](./TRUST.md) and the README's *Verifying a release* section; if a
published artifact fails verification, treat it as a security report and use
the private route above.
