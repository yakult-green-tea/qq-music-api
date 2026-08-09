# Repository automation guide

This file defines the operating rules for coding agents and other automation working in this repository. It does not describe a runtime agent architecture.

## Scope

- `main` is the maintained branch and the target for pull requests.
- Keep changes narrowly scoped. Do not combine repository governance, dependency upgrades, runtime behavior changes, and releases in one pull request.
- Do not modify external consumer repositories, including Folia, as part of work in this repository.
- Preserve the upstream MIT `LICENSE` verbatim and keep upstream attribution in `ATTRIBUTION.md`.

## Safety

- Never commit QQ credentials, cookies, QR session values, auth-state files, `.env` files, logs containing tokens, or local AI-tool configuration.
- Treat `QQ_AUTH_STATE_PATH` data and injected auth-session repositories as sensitive host-managed state.
- Do not publish to npm, create or move release tags, or change the package version without explicit maintainer authorization.
- Do not change the public/runtime API as part of documentation, CI, hook, or governance cleanup.

## Required verification

Before proposing a change, run the checks relevant to the diff. The authoritative full chain is:

```sh
npm ci
npm run lint
npm run build
npm test
npm run build:js
npm pack --dry-run
```

GitHub Actions is the merge quality gate. Local Husky hooks provide only fast feedback:

- `pre-commit` runs `lint-staged`.
- `commit-msg` runs `commitlint`.
- Do not add a full build or test suite to `pre-push`.

Some legacy route tests can contact real QQ Music endpoints. Do not classify a test as live merely because it imports `supertest`; mocked controller tests and local Koa route tests must remain in the blocking suite. Any future live-test split must use an explicit file convention or manifest, include nested and JavaScript suites, and preserve coverage enforcement for the blocking suite.

## Project boundaries

- Runtime code lives under `src/` and follows the existing `controller -> service -> util` flow.
- Explorer metadata is maintained in `src/config/apiExplorer.ts`; browser assets live under `public/explorer/`.
- Compiled package output is created by `npm run build:js`; do not edit `dist/` manually.
- Runtime imports belong in `dependencies`; test and build-only packages belong in `devDependencies`.

## Pull requests

- Use short-lived branches such as `feat/`, `fix/`, `docs/`, `test/`, or `chore/`.
- Explain package/API impact, tests run, and whether any test contacts a live upstream.
- Keep the required GitHub check context named `verify` unless branch protection is deliberately migrated at the same time.
