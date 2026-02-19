# Contributing

## Setup

```sh
bun install
bun l        # typecheck + lint + tests
```

## Making changes

- All logic lives in `src/` — `converter.ts` is the core algorithm
- Add tests in `test/` for anything non-trivial
- Run `bun l` before committing — CI will reject if it fails

## Releasing (maintainers)

```sh
bun run release:patch   # bug fix
bun run release:minor   # new feature
bun run release:major   # breaking change
```

This bumps `package.json`, tags, and pushes. GitHub Actions publishes to npm automatically.
