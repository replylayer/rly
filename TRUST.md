# Trust — what each `rly` install artifact is, and how it is built

This page states, artifact by artifact, what runs on your machine, what it
requires, and where it is built. Claims stronger than this table are wrong;
if you find one on any ReplyLayer surface, report it (see `SECURITY.md`).

| Artifact / install route | What runs | Host requirement | Build origin |
|---|---|---|---|
| `npm i -g rly` | The JavaScript CLI (`dist/bin/replylayer.js`) on your host Node runtime | Node.js 22+, npm | ReplyLayer's release pipeline; verify registry signatures with `npm audit signatures` |
| `pipx install rly` (supported wheel) | A bundled native executable via a Python launcher | Python 3.10+; **no Node toolchain** | ReplyLayer's private release pipeline; wheels published via PyPI Trusted Publishing |
| PyPI sdist / unsupported platform | The Python launcher **without** a bundled binary | Python; Node 22+ only under the explicit `RLY_FORCE_NPX=1` fallback | Same pipeline; there is **no automatic** npx fallback |
| winget `ReplyLayer.CLI` (Windows x64) | An Authenticode-signed native executable | Supported Windows x64 | Privately built and signed; the exact binary is published on this repository's Releases and hash-pinned in the winget manifest |
| Release assets on this repository | GPG-signed `SHA256SUMS`, SBOMs, PyPI wheels/sdist, the Windows x64 executable | — | Mirrored here so `KEYS.txt` can verify a download |

Things this table deliberately does **not** claim:

- npm does not carry its own runtime and has a real Node 22+ requirement — the
  npm package contains no native binary.
- A public source tag, when one exists, proves the **JavaScript** package's
  source only. Native binaries inside PyPI wheels and the winget executable are
  built and signed privately; their trust anchors are the signed checksum
  manifest, platform signatures/notarization, SBOMs, and SLSA attestations —
  not a public source build.
- `engines.node` does not guarantee an old-Node `npm install` fails; old Node
  is unsupported, not deterministically rejected.

## Verifying what you installed

The step-by-step walkthrough lives in the [README](./README.md#verifying-a-release).
The GPG signing key is distributed only via [`KEYS.txt`](./KEYS.txt) in this
repository — not public keyservers.

## Source status

A standalone public CLI source checkout is **not yet available** in this
repository; it currently provides installation and package-trust material. When
source-backed releases begin, each release tag will identify the exact public
source commit for the published npm package, and this page will say so
explicitly. Historical tags from the docs-only era do not contain CLI source
and are never retroactively described as source-backed.
