# Contributing to Control Tower

Thanks for helping. Bug reports, docs fixes, provider adapters and new detectors are all welcome.

## Before you start

- **Security issues** go through [private vulnerability reporting](SECURITY.md), not public issues.
- For anything bigger than a small fix, open an issue first so we can agree on the approach before you spend time on it.

## Development setup

You need **Node 24** and **pnpm 10** (`corepack enable` picks up the pinned version).

```bash
pnpm install
CT_DEMO=1 pnpm dev        # gateway + console on http://localhost:4000, with a synthetic agent fleet
pnpm dev:ui               # optional: Vite dev server for the console with hot reload
```

Demo mode needs no provider keys: stand-in providers answer locally, and nothing leaves your machine.

## Checks

Run these before opening a pull request — CI runs the same:

```bash
pnpm typecheck
pnpm test                 # unit tests (vitest)
pnpm build
pnpm test:e2e             # Playwright, against the built bundle (run `pnpm build` first)
```

## Code

- TypeScript strict with `exactOptionalPropertyTypes`; no `any` in new code unless there is no better option.
- Keep the layout flat and readable: `server/` (gateway, policy, MCP, admin API), `ui/` (console), `shared/` (types used by both), `site/` (landing page).
- Match the surrounding code's style, naming and comment density. Comments explain *why*, not what.
- Anything that touches credentials, request bodies or events: never log or emit secrets or bodies. Redaction is structural — keep it that way.
- The map must stay honest: a line is solid only when Control Tower is actually in the path.

## Pull requests

- One focused change per PR, with a short description of what and why.
- Add or update tests for behaviour changes.
- UI changes: include a screenshot.

## License

Control Tower is Apache-2.0. By contributing you agree your contribution is licensed under the same terms.
