# Contributing

Thanks for your interest in `rly`.

## How this repository works

This repository is a public install, trust, and (in future) source surface for
the ReplyLayer CLI. Its contents fall into three classes:

- **Managed CLI source paths** (`src/`, `package.json`, `package-lock.json`,
  `tsconfig.json`, `CLI_GUIDE.md`, `LICENSE`, `.nvmrc`, `.rly-source.json` —
  absent until the first source seed): generated from a canonical upstream and
  replaced on every source sync. Pull requests that edit these paths directly
  cannot be merged — the next sync would overwrite them. Report the change you
  want (or open a PR as a *proposal*); an accepted change is applied upstream
  and arrives in the next managed sync PR.
- **Public-owned control plane** (`README.md`, `TRUST.md`, `SECURITY.md`,
  `.github/**`): human-reviewed here; changes to workflows, checkers, and
  fixtures are publishing-control changes and get owner review.
- **`langchain-python/`**: a read-only source mirror of the
  `langchain-replylayer` PyPI package, regenerated at each adapter release —
  same rule as managed paths: file issues, don't patch the mirror.

## Issues

Bug reports and feature requests are welcome on this repository's issue
tracker. For anything security-sensitive, use the private route in
[`SECURITY.md`](./SECURITY.md) instead of a public issue.

Questions about this contribution model are also welcome on the issue tracker.
