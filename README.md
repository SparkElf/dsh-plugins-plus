# dsh-plugins-plus

SparkElf-maintained independent plugins for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh). Plugins here are installable on upstream dsh through profile composition bundles (`dsh plugin --profile <name> add <package-or-git-spec>`; each package declares its Cordis plugin entry) and never depend on the `deepseek-harness-plus` product fork.

## Repository split

- `deepseek-harness-plus` tracks dsh and the Plus product, and curates third-party plugins via its pinned manifest.
- This repository holds the source of our own plugins so they remain usable with vanilla dsh. Created together with the first in-house plugin per the maintenance scheme note in `deepseek-harness-plus` (`.agents/notes/proposed/architecture/2026-08-19-external-plugin-maintenance.md`).

## Plugins

- `@sparkelf/dsh-plugin-ping` — `/ping` connectivity smoke command; replies `pong` without a model call.
- `@sparkelf/dsh-mobile-bridge` — outbound tunnel to the mobile bridge server plus a narrow-width mobile overlay that reuses the stock design system.
- `@sparkelf/dsh-mobile-bridge-server` — multi-user bridge server (username/password registration, session tokens, user-to-bridge binding, WebSocket relay) so phones reach a local Harness through your server.

## CI / CD

- CI (`ci.yml`): pnpm install, `tsc --noEmit`, vitest unit tests on every push and PR.
- CD (`publish.yml`): on `v*` tags, publishes packages to npm using the `NPM_TOKEN` secret; add the secret before the first tag.

## Adding a plugin

1. Create `packages/<name>` with `name`, `inject`, `apply` following the cordis plugin pattern (`@deepseek-ai/dsh-command-compact` in upstream dsh is the reference).
2. Add keyless unit tests beside it.
3. Keep the plugin dependency-free of `deepseek-harness-plus`; depend only on published upstream packages (`@deepseek-ai/cordis`, `@deepseek-ai/dsh-*`).
4. Bump the package version and tag `v<repo-version>` to publish.
