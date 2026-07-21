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

### winget (Windows x64)

The winget package is `ReplyLayer.CLI`. It needs no Node or Python toolchain.

```powershell
winget install --id ReplyLayer.CLI -e
rly --help
```

**Windows x64 only** — there is no arm64 package — and it installs the `rly`
command alone, not the `replylayer` alias. The installer is the Windows x64
binary published on this repository's releases, and its hash is pinned in the
winget manifest from the same GPG-signed `SHA256SUMS` described below.

Submitting to the winget community source is a manual step in our release
process, so this package can trail the newest npm/PyPI release — sometimes by
more than one version. `npm i -g rly` is always the first channel to carry a new
release; use it if you need the latest immediately.

To update or remove:

```powershell
winget upgrade --id ReplyLayer.CLI -e
winget uninstall --id ReplyLayer.CLI -e
```

### Install-channel collisions

npm, pipx, and winget can each put an `rly` on your `PATH`. Your shell runs
whichever comes first, so a fresh `winget install` can look like it did nothing
or installed an old version when an earlier npm or pipx install is actually
winning.

Keep one global install channel active at a time. To see which executable is
live:

```powershell
Get-Command rly -All   # Windows PowerShell (or: where.exe rly)
```

```bash
which -a rly   # macOS / Linux
```

In PowerShell, bare `where` is an alias for `Where-Object`, not the `where.exe`
program — use one of the two forms above.

Then remove the channels you are not using:

```powershell
winget uninstall --id ReplyLayer.CLI -e
npm uninstall -g rly
pipx uninstall rly
```

`rly --version` reports the version of whichever executable actually ran —
compare it against the channel you expect before filing an issue.

## Package Links

- npm: https://www.npmjs.com/package/rly
- PyPI: https://pypi.org/project/rly/
- winget: https://github.com/microsoft/winget-pkgs/tree/master/manifests/r/ReplyLayer/CLI

## Verifying a release

Every CLI release publishes a GPG-signed checksum manifest so you can verify a
download. The signing key is in [`KEYS.txt`](./KEYS.txt) in this repository.

**What the manifest covers:** the **PyPI wheels and sdist** (byte-identical to
the files on PyPI) and the platform binaries. The **npm** package is *not*
covered by this manifest; verify npm registry signatures separately with `npm
audit signatures`.

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
   # GNU/Linux: verify every listed file you actually have, skip the rest
   sha256sum --ignore-missing -c SHA256SUMS

   # any platform: verify one file by name (replace with your download)
   grep '<your-downloaded-file>' SHA256SUMS | sha256sum -c
   ```

   On macOS use `shasum -a 256 -c` in place of `sha256sum -c` (the `grep` form).

## Security

Please report security issues privately to `security@replylayer.ai`.

## Source

This repository is a public install and package-trust surface for ReplyLayer's CLI. The main product source is maintained separately.

## `langchain-python/` — LangChain adapter source mirror

[`langchain-python/`](./langchain-python) is a read-only source mirror of the [`langchain-replylayer`](https://pypi.org/project/langchain-replylayer/) PyPI package, updated automatically at each release and proven byte-identical to the released sdist. File issues here; pull requests against this directory cannot be merged directly — it is regenerated from the upstream source at every release.
