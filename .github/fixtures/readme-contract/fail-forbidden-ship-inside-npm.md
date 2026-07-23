# rly (fixture: complete consumer contract)

The command-line interface for **ReplyLayer** — safe email for AI agents. Not a
bulk or marketing tool.

## Install

```bash
npm install -g rly               # Node.js 22+
pipx install rly                 # bundled native launcher, no Node toolchain needed
```

## Quickstart

```bash
rly doctor --json
rly send --from box --to delivered@simulator.replylayer.net --subject hi --body hi --json
# branch on the JSON `status`
```

## Auth

`REPLYLAYER_API_KEY`, or `rly auth login`. Complete bootstrap with
`rly auth verify --code <code>`.

## For agents

Every command supports `--json`. Branch on the JSON `status`, not the exit code.
`send --strict` adds distinct outcome exit codes.

```bash
MSG=$(rly --json inbox wait --mailbox support-bot --since "$SINCE" --timeout 30)
```

## Verifying a release

Download `SHA256SUMS` and its signature; the signing key is in `KEYS.txt`.

## Security

Report security issues privately to `security@replylayer.ai`.

## Source

This repository is a public install and package-trust surface.

## `langchain-python/` — LangChain adapter source mirror

Read-only source mirror of the `langchain-replylayer` PyPI package.

Raw binaries ship inside the npm/PyPI packages.
