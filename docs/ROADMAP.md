# Roadmap

What we are building, in order, without dates. Derived from the internal decisions log (the frozen v1 scope and the
numbered decisions); when they change, this page changes with them. "Now" is in the current stage,
"Next" follows it, "Later" is after v1. Ask for something with a feature request issue: the votes there move items
between columns.

| Now | Next | Later |
|---|---|---|
| **Admin:** roles `support` / `admin` and "view as a user" with every call audited; the pilot report (`GET /v1/report`, CSV); the wish map (requests the panels could not serve, grouped per panel); code search across users' versions and rollback by selection; screens for flags, events, the audit chain, plan and usage | **Numbers:** 50 real requests on three open-source admin apps on a live model, published in the README (first-try %, p95 time, $ per edit) | **Frameworks:** webpack and Metro adapters, Expo, Electron and Tauri, Module Federation |
| **Releases:** carry every user's edits over to a new release in one run with a dollar budget, resumable, and roll a release back (`pleatkit carry-over`) | **Model choice by evals:** Sonnet, Haiku, Opus, OpenAI-compatible models and the Agent SDK compared on the same tasks; a weekly regression run | **UI kits:** MUI and Emotion profiles next to Tailwind + shadcn |
| **Operations:** the weekly digest by e-mail or webhook (`pleatkit digest --week`); `pleatkit report` for bug reports; [SECURITY.md](../SECURITY.md) and private vulnerability reporting; [SUPPORTED.md](../SUPPORTED.md) | **Next.js** through code generation (`pleatkit generate`), right after v1 | **Enterprise:** SSO and SCIM, Bedrock / Azure / Vertex as model providers, a DLP hook, SIEM export of the audit log, tenant hierarchies |
| **The drawer on phones:** full-screen on small screens; `HttpStore` (store-server) as the default in the install guide | **Publishing:** packages on npm with provenance; a public demo with daily limits | **Editing:** a before/after preview, sharing a version with a colleague, voice input |
| **Organizations:** one version per customer organization by default, with personal versions as an option; three "tune it" buttons; recipes as named actions in the empty chat | **Edits that graduate:** promote an edit that everyone keeps into a pull request to the app's repository | **Wish map to tickets:** export themes to Linear and GitHub issues, updated on every digest |
| **Rules:** images and links from data only for hosts the app allows (`allowedHosts`), with the same list in the CSP recipe | **Agents in:** an MCP entry point to the agent server | **Quality:** a judge model for edits, A/B of prompts in production |
| **Documents:** data flows, subprocessors, retention, incident response and DPA templates for security reviews; a pilot agreement with success criteria | **Platform:** Postgres for store-server; a data deletion API; tests on Safari and Firefox | **Recipes across customers:** shared recipes written by us from demand signals, never from another customer's code |
