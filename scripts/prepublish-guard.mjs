/**
 * Refuse a package-manager publish that bypasses the tarball gate.
 *
 * `prepublishOnly` runs before `prepack`, so it cannot inspect the tarball: the artifact does
 * not exist yet. What it can do is make the unsupported path loud. Publishing these packages
 * goes through `scripts/publish-package.mjs`, which packs, verifies the tarball carries every
 * declared entry file, then publishes the verified tarball.
 *
 * The marker exists for the wrapper's own tooling and for a deliberate manual override; an
 * ordinary `npm publish` / `pnpm publish` in a package directory fails here.
 */
if (process.env.DSH_PUBLISH_GATE !== '1') {
  console.error('prepublish-guard: publish through `pnpm run publish:package -- --dir <package>`;')
  console.error('prepublish-guard: it verifies the packed tarball carries every package.json entry file before publishing.')
  process.exit(1)
}
