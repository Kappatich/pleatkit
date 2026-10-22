# Security policy

pleatkit runs code written by a model inside other people's applications, so we treat security reports as the most
urgent thing we get.

## Reporting a vulnerability

**Do not open a public issue.** Use GitHub's private vulnerability reporting:
[Report a vulnerability](https://github.com/Kappatich/pleatkit/security/advisories/new) (repository → Security →
Advisories → "Report a vulnerability"). If you cannot use GitHub, e-mail security@pleatkit.com.

Please include what you can of: the affected package and version (`pleatkit report` prints them and redacts
secrets), the steps or a proof of concept, and the impact you see. A bypass of the static rules is a vulnerability
even without a working exploit: send the snippet the rules let through.

What happens next:

| When | What |
|---|---|
| within 24 hours | we confirm we have the report |
| within 7 days | we tell you whether we reproduce it and how severe we think it is |
| fix | a regression test first (a rule bypass goes into `packages/runtime/test/check.test.ts`), then the fix and a release; Cloud is patched before the advisory is published |
| publication | a GitHub security advisory with a CVE when it applies, crediting you if you agree |

We will not take legal action against research done in good faith that respects users' data: test on your own
installation (`examples/t1-vite` or the demo), not on someone else's app or pleatkit Cloud tenants, and stop at the
proof that something is possible.

## Supported versions

Before 1.0 only the latest minor release gets security fixes. Supported runtimes: [SUPPORTED.md](SUPPORTED.md).

## What is in scope

- The static rules that decide what generated code may do (`packages/runtime/src/check.ts`): network requests,
  computed URLs, cookies and storage, `eval`, navigation, escaping the zone, protected elements.
- Bundle signing and verification, user tokens and roles (`user` / `admin`; other roles and `x-pleatkit-act-as`
  must be refused with 403 `cloud-feature` by the open store).
- store-server's tenancy: one user reading or writing another user's versions, one app another app's data.
- The agent server: prompt injection that makes it write code the rules should refuse, quota and budget bypasses.

Out of scope: findings that need a compromised customer backend or app key, denial of service by volume against a
self-hosted instance without its quotas, and the demo app's development-only headers (`x-pleatkit-*`, refused in
production).

## For operators

The incident runbook is [docs/ops/incident.md](docs/ops/incident.md); data flows, subprocessors and retention are in
[docs/security/](docs/security/).
