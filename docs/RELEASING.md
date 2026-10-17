# Releasing morphkit to npm (V1 A6)

Nothing is published yet: the `@morphkit` scope and the npm account belong to Minte (DECISIONS 27). This
page is the prepared path, so the first release is a checklist, not a project.

## Principles

- **No npm tokens anywhere.** Not in `.npmrc`, not in CI secrets, not in the environment of coding agents.
  Publishing uses npm *trusted publishing*: npm trusts a GitHub Actions workflow through OIDC and issues a
  one-time credential for that run only.
- **Provenance on every package.** `.npmrc` sets `provenance=true` and every public package has
  `publishConfig.provenance: true`, so npm shows which commit and workflow built the tarball.
- **2FA on the npm account** (auth and writes) and on the GitHub account that owns the repository.
- Only the MIT packages are published: `@morphkit/runtime`, `@morphkit/vite-plugin`, `@morphkit/ui`,
  `@morphkit/agent`, `@morphkit/cli`. `@morphkit/store-server` is `private` and never published (F12).

## One-time setup (Minte)

1. Create the npm organization `morphkit` (scope `@morphkit`); enable "Require two-factor authentication"
   for the organization.
2. For the very first version of each package, trusted publishing cannot be configured before the package
   exists. Either publish `0.0.0-placeholder` once from Minte's machine with 2FA
   (`npm publish --access public` in each package, then deprecate it), or use npm's "pending trusted
   publisher" if the account has it.
3. On npmjs.com, for each of the five packages: Settings → Trusted publishing → GitHub Actions, repository
   `Kappatich/morphkit`, workflow `release.yml`, environment `npm`.
4. In GitHub: create the environment `npm` with a required reviewer (Minte), so a release always needs a click.
5. Copy `docs/release/release.yml` to `.github/workflows/release.yml` and push it.

## Each release

1. Update `CHANGELOG.md` (see the breaking-change policy in the README) and bump versions
   (`pnpm -r exec npm version <x.y.z> --no-git-tag-version` in `packages/*` except store-server).
2. `pnpm install && pnpm build && pnpm test && pnpm e2e` locally; commit; tag `v<x.y.z>`; push.
3. GitHub → Actions → release → Run workflow with `dry_run: true`: it builds, tests and packs.
4. Run again with `dry_run: false`; approve the `npm` environment. The workflow publishes with
   `--provenance --access public`.
5. Check on npmjs.com that each version shows "Built and signed on GitHub Actions".

## After publishing

The install steps in `docs/for-agents/install.md` switch from `link:` to registry versions; the
`resolve.dedupe` step and the doctor warning about two React copies go away for registry installs.
