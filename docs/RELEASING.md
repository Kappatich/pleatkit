# Releasing pleatkit to npm (V1 A6)

The `@pleatkit` scope and the npm account belong to Minte (DECISIONS 27): only Minte publishes. The first release,
0.4.0, is published by hand from Minte's machine (below, "0.4.0: the first publish"); later releases go through the
GitHub Actions workflow with trusted publishing ("Each release after 0.4.0").

## Principles

- **No npm tokens in the repository or in CI.** Not in `.npmrc`, not in CI secrets, not in the environment of coding
  agents. The first publish uses Minte's own `npm login` session with 2FA; later ones use npm *trusted publishing*:
  npm trusts a GitHub Actions workflow through OIDC and issues a one-time credential for that run only.
- **Provenance from CI.** npm can attest a package only when it is published from a supported CI, so provenance is
  not in `publishConfig` or `.npmrc` (a publish from a laptop would fail with it); the release workflow passes
  `--provenance`. The by-hand 0.4.0 has no provenance badge; every later version has one.
- **2FA on the npm account** (auth and writes) and on the GitHub account that owns the repository.
- Only the MIT packages are published: `@pleatkit/runtime`, `@pleatkit/vite-plugin`, `@pleatkit/ui`,
  `@pleatkit/agent`, `@pleatkit/cli` and `@pleatkit/store-server` (the open store, DECISIONS 70.1). The managed
  cloud's packages (`@pleatkit/store-cloud`, `@pleatkit/agent-cloud`, `@pleatkit/admin-cloud`) live in the private
  pleatkit-cloud repository; the demo, the evals and the example apps are `private` and never published (F12).
  `node scripts/release-check.mjs` fails when a private package would be published or a public one depends on it.

## Two checks before any publish (anyone may run them; they never publish)

```bash
pnpm install --frozen-lockfile
node scripts/release-check.mjs     # alias: pnpm release:check
node scripts/npm-smoke.mjs --from packed --dir <empty temp folder>     # alias: pnpm release:smoke -- …
```

- `release-check`: build, tests, the version matrix (every public package at the CHANGELOG's version, `VERSION` in
  `packages/cli/src/cli.ts` and `PLUGIN_VERSION` in `packages/vite-plugin/src/index.ts`, `workspace:` ranges between
  pleatkit packages), metadata (`license` MIT, `homepage` https://pleatkit.com, `publishConfig.access` public and no
  `provenance` there or in `.npmrc`, `files`, `exports`, `repository`, README and LICENSE in each package, no
  pre-rename names in `dist`) and `pnpm -r publish --dry-run --no-git-checks`, which must list every public package
  and none of the private ones. Ends with `release check passed: 6 public packages at <x.y.z>, nothing published`.
- `npm-smoke --from packed`: packs the six packages (`pnpm pack` turns `workspace:*` into the exact version and
  `workspace:^` into `^<version>`), installs the tarballs into a fresh `create vite@7` React app by the npm route of
  `docs/for-agents/install.md`, builds it, runs `pleatkit doctor`, and makes one chat edit headless (scripted provider)
  on the dev server and on `vite preview`. Ends with `npm smoke passed`. Ports 5173, 4173, 8789, 8790 must be free.

## 0.4.0: the first publish (Minte, by hand)

Prepared and checked on 2026-11-09 (release check and packed smoke green). On a clean `main` that has the release
commit, with Node 22 and pnpm 10, in the repository root:

1. **The two checks above.** Both must pass. `git status` must be clean.
2. **Log in to npm** (opens the browser; use the account that will own the scope, with 2FA on):

   ```bash
   npm login
   npm whoami
   ```

3. **Create the scope** if `npm org ls pleatkit` answers 404: on https://www.npmjs.com, avatar → *Add
   Organization* → name `pleatkit` → the free plan (public packages only). The scope `@pleatkit` comes with it. In the
   organization's settings turn on *Require two-factor authentication*. Check: `npm org ls pleatkit` lists you as
   `owner`.
4. **Date the release** in `CHANGELOG.md`: `## 0.4.0 (unreleased)` → `## 0.4.0 (<today>)`, then
   `git add CHANGELOG.md && git commit -m "release 0.4.0"`.
5. **Publish** the six packages from the repository root:

   ```bash
   pnpm -r publish --access public --no-git-checks
   ```

   pnpm builds nothing here (the check built `dist`), packs each public package with the `workspace:` ranges replaced
   and runs `npm publish` for it; the private packages are skipped. With 2FA for writes, npm asks for a one-time code
   (or a browser confirmation) per package; `--otp <code>` passes one up front, but a code expires after 30 s. If the
   run stops halfway, run the same command again: pnpm skips versions already on the registry.
6. **Tag and push**:

   ```bash
   git tag -a v0.4.0 -m "pleatkit 0.4.0"
   git push origin main v0.4.0
   ```

7. **Check the registry**:

   ```bash
   npm view @pleatkit/runtime
   for p in runtime ui vite-plugin agent cli store-server; do npm view @pleatkit/$p version; done   # 0.4.0 six times
   npm view @pleatkit/runtime dist-tags.latest                                                      # 0.4.0
   ```

8. **Fresh install from npm**: the same smoke, now from the registry:

   ```bash
   node scripts/npm-smoke.mjs --from registry --version 0.4.0 --dir <empty temp folder>
   ```

   It must end with `npm smoke passed` (6/6 packages at 0.4.0 from the registry, build, doctor, a chat edit on the dev
   server and on preview). By hand, in any new Vite + React app: `pnpm add @pleatkit/runtime @pleatkit/ui` and
   `pnpm add -D --allow-build=better-sqlite3 @pleatkit/vite-plugin @pleatkit/agent @pleatkit/cli @pleatkit/store-server`.

If something is wrong after publishing: `npm deprecate @pleatkit/<name>@0.4.0 "<why>"` and publish 0.4.1. npm allows
`npm unpublish` only within 72 hours and never reuses a version number, so prefer a fix release.

## Each release after 0.4.0 (trusted publishing from GitHub Actions)

One-time setup (Minte, after 0.4.0 exists on npm):

1. On npmjs.com, for each of the six packages: Settings → Trusted publishing → GitHub Actions, repository
   `Kappatich/pleatkit`, workflow `release.yml`, environment `npm`.
2. In GitHub: create the environment `npm` with a required reviewer (Minte), so a release always needs a click.
3. Copy `docs/release/release.yml` to `.github/workflows/release.yml` and push it.

Each release:

1. Update `CHANGELOG.md` (a `## <x.y.z>` heading on top; see the breaking-change policy in the README) and bump
   the public packages together (`pnpm --filter "./packages/*" exec npm version <x.y.z> --no-git-tag-version`; the
   private ones may keep theirs), plus `VERSION` in `packages/cli/src/cli.ts` and `PLUGIN_VERSION` in
   `packages/vite-plugin/src/index.ts`.
2. The two checks above, then `pnpm e2e`; commit; tag `v<x.y.z>`; push.
3. GitHub → Actions → release → Run workflow with `dry_run: true`: it builds, tests and packs.
4. Run again with `dry_run: false`; approve the `npm` environment. The workflow publishes with
   `--provenance --access public`.
5. Check on npmjs.com that each version shows "Built and signed on GitHub Actions", then
   `node scripts/npm-smoke.mjs --from registry --version <x.y.z>`.

## History

- 0.3.0 was prepared on 2026-10-18 (versions, README, LICENSE, `files`, the `Morphkit*` aliases removed) but never
  published; 0.4.0 (the open-core boundary, DECISIONS 89) is the first version on npm.
- Removed for 0.2 (DECISIONS 69): the `Morphkit*` aliases, the `morphkit` and `morphkit-agent` binaries,
  `virtual:morphkit/*`, `x-morphkit-*`, the `MORPHKIT_*` fallback and `@pleatkit/runtime/env` (CHANGELOG, Removed).
- Still waiting on Minte: the copyright line in `LICENSE` (now "the pleatkit authors").

## After publishing

Installs from the registry need no `resolve.dedupe` (one React is resolved anyway); it stays in install.md only for
the checkout route (`link:`), where the doctor's "two copies of React" warning is expected.
