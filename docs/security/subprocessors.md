> **Draft, for the lawyer.** Written from the code as of stage 4c (2026-10-18); not reviewed by counsel. `[[...]]`
> marks what Minte fills in. A change to this list is announced to Cloud customers [[notice period, e.g. 30 days]]
> before it takes effect.

# Subprocessors

Who processes customer data on pleatkit's behalf. Only **pleatkit Cloud** (and the hybrid mode for the store) has
subprocessors of pleatkit; a self-hosted installation sends data only where its operator configures it.

## pleatkit Cloud

| Subprocessor | Purpose | Data | Location | Since |
|---|---|---|---|---|
| Anthropic, PBC | model API: the classifier and the edit loop (`claude-haiku-5-5`, `claude-sonnet-5-5`), in the Cloud the wish-map call | request text, panel code, read-only sources and types of the app, DOM structure of the target panel (no values), screenshots the user attached; see [data-flows.md](data-flows.md) step 3 | [[region per the Anthropic agreement]] | [[date]] |
| [[hosting provider]] | runs the agent server and store-server, stores the SQLite database and its backups | everything store-server keeps ([data-flows.md](data-flows.md), "What store-server keeps") | [[region]] | [[date]] |
| [[e-mail API, if pleatkit sends alerts or digests by e-mail]] | alert and weekly digest e-mails to the customer's admins | alert titles, app and user ids, digest counts and wish-theme titles | [[region]] | [[date]] |

Not subprocessors (not in the code): analytics, advertising, error tracking with customer data, a CDN for customer
data. Compiled bundles are served by store-server itself. Library telemetry is off by default and carries no
customer data.

## Configurable by the customer (their choice, their contract)

| Component | When | Set by |
|---|---|---|
| OpenAI-compatible provider (OpenAI, OpenRouter, ...) instead of Anthropic | `PLEATKIT_PROVIDER=openai-compatible` on an agent server the customer runs | the customer |
| Alert webhook (Slack, PagerDuty, any HTTPS endpoint) | `PLEATKIT_ALERT_WEBHOOK` | the operator of the agent server |
| E-mail API for alerts and the digest | `PLEATKIT_ALERT_EMAIL_URL`, `_TO`, `_TOKEN` | the operator |
| Sentry or another error tracker | the customer adds `engine.tags()` to their own reporting | the customer |

## Model provider terms that matter here

- Customer content sent to the model API is processed under the provider's commercial terms; whether it is
  retained, for how long, and whether zero data retention applies is [[from the Anthropic agreement: ZDR yes/no]].
- pleatkit does not use customer content to train models, and does not send it to any provider for training.
- The `learning` flag (DECISIONS 44) is `off` by default and controls only pleatkit's own anonymous request facts
  inside the customer's tenant; it never sends data to a model provider.
