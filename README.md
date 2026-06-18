# rly

`rly` is the ReplyLayer command-line interface.

ReplyLayer provides safe email infrastructure for AI agents: mailboxes, sending, inbox workflows, scanning, quarantine, and approval flows designed for automated systems.

## Install

### npm

The official npm package is `rly` — the same name as on PyPI. It installs both the `rly` and `replylayer` commands. (The package was previously published as `replylayer`; that name is deprecated.)

```bash
npm i -g rly
rly --help
```

### PyPI

The PyPI package is `rly`. Use `pipx` for a global CLI install.

```bash
pipx install rly
rly --help
```

On Debian and Ubuntu systems that enforce PEP 668, plain `pip install rly` may fail with `externally-managed-environment`. Use `pipx install rly`, or install inside a virtual environment.

## Package Links

- npm: https://www.npmjs.com/package/rly
- PyPI: https://pypi.org/project/rly/

## Verifying a release

Every CLI release publishes a GPG-signed checksum manifest so you can verify a
download. The signing key is in [`KEYS.txt`](./KEYS.txt) in this repository.

**What the manifest covers:** the **PyPI wheels and sdist** (byte-identical to
the files on PyPI) and the platform binaries. The **npm** package is *not*
covered by this manifest — the npm registry signs published packages and the
npm CLI verifies that signature automatically on install (`npm audit
signatures` reports it for installed dependencies).

1. Download the manifest, its signature, and the signing key:

   ```bash
   base=https://github.com/replylayer/rly/releases/latest/download
   curl -fsSLO "$base/SHA256SUMS"
   curl -fsSLO "$base/SHA256SUMS.sig"
   curl -fsSL https://raw.githubusercontent.com/replylayer/rly/main/KEYS.txt | gpg --import
   ```

2. Verify the manifest signature — expect
   `Good signature from "ReplyLayer CLI Releases <cli-releases@replylayer.ai>"`:

   ```bash
   gpg --verify SHA256SUMS.sig SHA256SUMS
   ```

3. Verify the file you actually downloaded. The manifest lists every release
   artifact — including binaries not attached to this repo — so check **only
   your file** with a filtered match. A bare `sha256sum -c SHA256SUMS` would
   fail on the absent entries.

   ```bash
   # a wheel installed from PyPI (substitute your version / platform tag)
   grep 'rly-0.7.3-py3-none-manylinux_2_28_x86_64.whl' SHA256SUMS | sha256sum -c
   # or the sdist
   grep 'rly-0.7.3.tar.gz' SHA256SUMS | sha256sum -c
   ```

   On macOS use `shasum -a 256 -c` in place of `sha256sum -c`.

## Security

Please report security issues privately to `security@replylayer.ai`.

## Source

This repository is a public install and package-trust surface for ReplyLayer's CLI. The main product source is maintained separately.
