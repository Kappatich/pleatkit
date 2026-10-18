# Releasing pleatkit to npm (V1 A6)

Nothing is published yet: the `@pleatkit` scope and the npm account belong to Minte (DECISIONS 27). This
page is the prepared path, so the first release is a checklist, not a project.

## Principles

- **No npm tokens anywhere.** Not in `.npmrc`, not in CI secrets, not in the environment of coding agents.
  Publishing uses npm *trusted publishing*: npm trusts a GitHub Actions workflow through OIDC and issues a
  one-time credential for that run only.
- **Provenance on every package.** `.npmrc` sets `provenance=true` and every public package has
  `publishConfig.provenance: true`, so npm shows which commit and workflow built the tarball.
- **2FA on the npm account** (auth and writes) and on the GitHub account that owns the repository.
- Only the MIT packages are published: `@pleatkit/runtime`, `@pleatkit/vite-plugin`, `@pleatkit/ui`,
  `@pleatkit/agent`, `@pleatkit/cli` and, since 0.2, `@pleatkit/store-server` (the open store, DECISIONS 70.1).
  `@pleatkit/store-cloud`, the demo, the evals and the smoke apps are `private` and never published (F12).

## One-time setup (Minte)

1. Create the npm organization `pleatkit` (scope `@pleatkit`); enable "Require two-factor authentication"
   for the organization.
2. For the very first version of each package, trusted publishing cannot be configured before the package
   exists. Either publish `0.0.0-placeholder` once from Minte's machine with 2FA
   (`npm publish --access public` in each package, then deprecate it), or use npm's "pending trusted
   publisher" if the account has it.
3. On npmjs.com, for each of the six packages: Settings → Trusted publishing → GitHub Actions, repository
   `Kappatich/pleatkit`, workflow `release.yml`, environment `npm`.
4. In GitHub: create the environment `npm` with a required reviewer (Minte), so a release always needs a click.
5. Copy `docs/release/release.yml` to `.github/workflows/release.yml` and push it.

## Each release

1. Update `CHANGELOG.md` (a `## <x.y.z>` heading on top; see the breaking-change policy in the README) and bump
   the public packages together (`pnpm --filter "./packages/*" exec npm version <x.y.z> --no-git-tag-version`; the
   private ones may keep theirs), plus `VERSION` in `packages/cli/src/cli.ts` and `PLUGIN_VERSION` in
   `packages/vite-plugin/src/index.ts`.
2. `node scripts/release-check.mjs`: build, tests, the version matrix (every public package at the CHANGELOG's
   version, the two constants, `workspace:` ranges between pleatkit packages), metadata (`license`, `files`,
   `exports`, `repository`, `publishConfig.access`, README and LICENSE in each package, no pre-rename names in
   `dist`) and `pnpm -r publish --dry-run --no-git-checks`, which must list every public package and none of the
   private ones. It never publishes. Then `pnpm e2e`; commit; tag `v<x.y.z>`; push.
3. GitHub → Actions → release → Run workflow with `dry_run: true`: it builds, tests and packs.
4. Run again with `dry_run: false`; approve the `npm` environment. The workflow publishes with
   `--provenance --access public`.
5. Check on npmjs.com that each version shows "Built and signed on GitHub Actions".

## 0.2.0, the first public release (prepared 2026-10-18, not published)

- Versions: runtime, vite-plugin, agent, cli, store-server at 0.2.0. `@pleatkit/ui` stays at 0.1.0 in the tree
  until the architect applies [`release/ui-0.2.patch`](release/ui-0.2.patch) (version, README, LICENSE, `files`,
  the `Morphkit*` aliases removed; `git apply docs/release/ui-0.2.patch`): packages/ui is the architect's.
  `node scripts/release-check.mjs` fails on exactly that until then.
- Removed for 0.2 (DECISIONS 69): the `Morphkit*` aliases, the `morphkit` and `morphkit-agent` binaries,
  `virtual:morphkit/*`, `x-morphkit-*`, the `MORPHKIT_*` fallback and `@pleatkit/runtime/env` (CHANGELOG, Removed).
- Waiting on Minte: the npm organization `@pleatkit`, trusted publishing for the six packages, the `npm`
  environment in GitHub, and the copyright line in `LICENSE` (now "the pleatkit authors").

## After publishing

The install steps in `docs/for-agents/install.md` switch from `link:` to registry versions; the
`resolve.dedupe` step and the doctor warning about two React copies go away for registry installs.
