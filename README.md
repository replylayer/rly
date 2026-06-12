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

## Security

Please report security issues privately to `security@replylayer.ai`.

## Source

This repository is a public install and package-trust surface for ReplyLayer's CLI. The main product source is maintained separately.
