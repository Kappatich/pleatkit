import { index, primaryKey, sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core'

/**
 * A full snapshot of one user's dynamic zone (same shape as `Snapshot` in @morphkit/runtime, plus appId).
 * Insert-only (code review 06 item 7): the primary key is (app, id), so an id known from another app never
 * reaches this app's row, and a trigger refuses any UPDATE except linking the agent request.
 */
export const snapshots = sqliteTable(
  'snapshots',
  {
    id: text('id').notNull(),
    appId: text('app_id').notNull(),
    userId: text('user_id').notNull(),
    parentId: text('parent_id'),
    files: text('files', { mode: 'json' }).$type<Record<string, string>>().notNull(),
    message: text('message').notNull(),
    author: text('author').notNull(),
    createdAt: text('created_at').notNull(),
    status: text('status').notNull(),
    baseHash: text('base_hash'),
    requestId: text('request_id'),
    /** F1, F2: tenant and placement of every record. */
    orgId: text('org_id').notNull().default('default'),
    region: text('region').notNull().default('local'),
    environment: text('environment').notNull().default('development'),
    /** V1 B5: per-file hashes of the base the snapshot was made from. */
    baseFiles: text('base_files', { mode: 'json' }).$type<Record<string, string>>(),
    /** F4: shape version of the snapshot. */
    schemaVersion: integer('schema_version').notNull().default(1),
  },
  (t) => [primaryKey({ columns: [t.appId, t.id] }), index('snapshots_by_user').on(t.appId, t.userId, t.id)],
)

export const heads = sqliteTable(
  'heads',
  {
    appId: text('app_id').notNull(),
    userId: text('user_id').notNull(),
    snapshotId: text('snapshot_id').notNull(),
    updatedAt: text('updated_at').notNull(),
    orgId: text('org_id').notNull().default('default'),
  },
  (t) => [primaryKey({ columns: [t.appId, t.userId] })],
)

/** One agent run: what was asked, what the agent decided, its tool log, and what happened to the result. */
export const requests = sqliteTable(
  'requests',
  {
    id: text('id').primaryKey(),
    appId: text('app_id').notNull(),
    userId: text('user_id').notNull(),
    text: text('text').notNull(),
    target: text('target'),
    verdict: text('verdict').notNull(),
    summary: text('summary').notNull(),
    /** proposed | applied | pending-review | clarifying | rejected | pending-admin | in-progress | rolled-back | failed */
    status: text('status').notNull(),
    classification: text('classification'),
    provider: text('provider'),
    model: text('model'),
    usage: text('usage', { mode: 'json' }).$type<unknown[]>(),
    timings: text('timings', { mode: 'json' }).$type<Record<string, unknown>>(),
    log: text('log', { mode: 'json' }).$type<unknown[]>().notNull(),
    /** Files the agent proposed (changed ones only). */
    files: text('files', { mode: 'json' }).$type<Record<string, string>>(),
    snapshotId: text('snapshot_id'),
    error: text('error'),
    /** Screenshots and panel DOM that came with the request: sizes only, the images are not stored. */
    attachments: text('attachments', { mode: 'json' }).$type<{ images: number; imageBytes: number; targetDomChars: number }>(),
    adminNote: text('admin_note'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    createdAtMs: integer('created_at_ms').notNull(),
    orgId: text('org_id').notNull().default('default'),
    region: text('region').notNull().default('local'),
    environment: text('environment').notNull().default('development'),
    /** F4: version of the agent's instructions that produced it. */
    promptVersion: text('prompt_version'),
    /** DECISIONS 44: closed-list label and a short gist (L0) from the classifier. */
    intentLabel: text('intent_label'),
    gist: text('gist'),
    /** When retention blanked the text and target (DECISIONS 44). */
    retainedAt: text('retained_at'),
  },
  (t) => [index('requests_by_app').on(t.appId, t.createdAtMs)],
)

/** Compiled bundles by content hash; shared by the users of one app. */
export const bundles = sqliteTable(
  'bundles',
  {
    appId: text('app_id').notNull(),
    hash: text('hash').notNull(),
    js: text('js').notNull(),
    css: text('css').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.appId, t.hash] })],
)

/**
 * Compiled bundles by content key. `owner` is '' for bundles the agent server compiled and signed (served
 * publicly under /v1/b/<app>/<key>.js); otherwise the user whose browser uploaded it, visible only to that user,
 * so one user can never plant code in another user's bundle cache.
 */
export const bundleFiles = sqliteTable(
  'bundle_files',
  {
    appId: text('app_id').notNull(),
    key: text('key').notNull(),
    owner: text('owner').notNull(),
    js: text('js').notNull(),
    css: text('css').notNull(),
    /** BundleSignature JSON (payload + ed25519 signature); null for browser-made bundles. */
    signature: text('signature', { mode: 'json' }).$type<Record<string, unknown>>(),
    createdAt: text('created_at').notNull(),
    orgId: text('org_id').notNull().default('default'),
  },
  (t) => [primaryKey({ columns: [t.appId, t.key, t.owner] })],
)

/** Token buckets for quotas (V1 A4): `tokens` refills continuously up to the bucket's capacity. */
export const quotaBuckets = sqliteTable(
  'quota_buckets',
  {
    appId: text('app_id').notNull(),
    key: text('key').notNull(),
    tokens: real('tokens').notNull(),
    updatedMs: integer('updated_ms').notNull(),
  },
  (t) => [primaryKey({ columns: [t.appId, t.key] })],
)

/** Plan and limits of an app as data (F14): overrides of the default plan, per app. */
export const appPlans = sqliteTable('app_plans', {
  appId: text('app_id').primaryKey(),
  plan: text('plan').notNull(),
  limits: text('limits', { mode: 'json' }).$type<Record<string, number>>().notNull(),
  updatedAt: text('updated_at').notNull(),
})

/**
 * F3: append-only usage ledger (billing, analytics, abuse detection grow out of it). Written by the agent server
 * (`edit.requested`, `tokens.used`, `cost.usd`) and by store-server (`edit.applied`, `edit.reverted`,
 * `edit.alive24h`, `editor.active`). Triggers refuse UPDATE and DELETE.
 */
export const events = sqliteTable(
  'events',
  {
    seq: integer('seq').primaryKey({ autoIncrement: true }),
    ts: text('ts').notNull(),
    tsMs: integer('ts_ms').notNull(),
    appId: text('app_id').notNull(),
    orgId: text('org_id').notNull(),
    userId: text('user_id'),
    region: text('region').notNull(),
    environment: text('environment').notNull(),
    type: text('type').notNull(),
    value: real('value').notNull(),
    unit: text('unit').notNull(),
    requestId: text('request_id'),
    source: text('source').notNull(),
    /** Unique per logical event, so retries never count twice. */
    dedupeKey: text('dedupe_key'),
    props: text('props', { mode: 'json' }).$type<Record<string, unknown>>(),
  },
  (t) => [index('events_by_app').on(t.appId, t.tsMs), index('events_by_type').on(t.appId, t.type, t.tsMs)],
)

/** F7: append-only audit log, one hash chain per app (each row hashes the previous row's hash). */
export const audit = sqliteTable(
  'audit',
  {
    seq: integer('seq').primaryKey({ autoIncrement: true }),
    appId: text('app_id').notNull(),
    orgId: text('org_id').notNull(),
    ts: text('ts').notNull(),
    actor: text('actor').notNull(),
    action: text('action').notNull(),
    objectType: text('object_type').notNull(),
    objectId: text('object_id'),
    details: text('details', { mode: 'json' }).$type<Record<string, unknown>>(),
    prevHash: text('prev_hash').notNull(),
    hash: text('hash').notNull(),
  },
  (t) => [index('audit_by_app').on(t.appId, t.seq)],
)

/** F6: flags and kill switches per app, org or user (user overrides org overrides app). */
export const flags = sqliteTable(
  'flags',
  {
    appId: text('app_id').notNull(),
    scope: text('scope').notNull(),
    scopeId: text('scope_id').notNull(),
    key: text('key').notNull(),
    value: text('value', { mode: 'json' }).$type<unknown>(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.appId, t.scope, t.scopeId, t.key] })],
)

/** F5: responses of writes by Idempotency-Key, replayed when a client retries. */
export const idempotency = sqliteTable(
  'idempotency',
  {
    appId: text('app_id').notNull(),
    caller: text('caller').notNull(),
    key: text('key').notNull(),
    method: text('method').notNull(),
    path: text('path').notNull(),
    bodyHash: text('body_hash').notNull(),
    status: integer('status').notNull(),
    body: text('body').notNull(),
    contentType: text('content_type'),
    createdAtMs: integer('created_at_ms').notNull(),
  },
  (t) => [primaryKey({ columns: [t.appId, t.caller, t.key] })],
)

/** Per-app settings an admin can change at runtime (moderation of agent edits). */
export const appSettings = sqliteTable('app_settings', {
  appId: text('app_id').primaryKey(),
  /** off | review */
  moderation: text('moderation').notNull(),
  updatedAt: text('updated_at').notNull(),
  /** DECISIONS 44: off | aggregate | contribute; null means the server's default. */
  learning: text('learning'),
})

/** L1 of the data flywheel (DECISIONS 44): a fingerprint per request, no text, no code, keyed ids. */
export const requestFacts = sqliteTable(
  'request_facts',
  {
    requestId: text('request_id').primaryKey(),
    appId: text('app_id').notNull(),
    orgId: text('org_id').notNull(),
    userKey: text('user_key').notNull(),
    panelKey: text('panel_key'),
    intentLabel: text('intent_label'),
    verdict: text('verdict').notNull(),
    firstTry: integer('first_try', { mode: 'boolean' }),
    turns: integer('turns').notNull(),
    toolCalls: integer('tool_calls').notNull(),
    costUsd: real('cost_usd').notNull(),
    latencyMs: integer('latency_ms'),
    promptVersion: text('prompt_version'),
    model: text('model'),
    provider: text('provider'),
    compilerVersion: text('compiler_version'),
    staticRuleHits: text('static_rule_hits', { mode: 'json' }).$type<string[]>().notNull(),
    /** alive24h | reverted:user | reverted:admin | errorboundary | stale */
    outcome: text('outcome'),
    learning: text('learning').notNull(),
    createdAtMs: integer('created_at_ms').notNull(),
  },
  (t) => [index('facts_by_app').on(t.appId, t.createdAtMs)],
)

/** Per-app secret salt for the HMAC keys of L1 (never exported, never sent). */
export const appSalts = sqliteTable('app_salts', {
  appId: text('app_id').primaryKey(),
  salt: text('salt').notNull(),
  createdAt: text('created_at').notNull(),
})

/** DECISIONS 42: agent runs by Idempotency-Key, shared by every agent server instance. */
export const agentRuns = sqliteTable(
  'agent_runs',
  {
    appId: text('app_id').notNull(),
    userId: text('user_id').notNull(),
    key: text('key').notNull(),
    /** running | done */
    state: text('state').notNull(),
    result: text('result', { mode: 'json' }).$type<Record<string, unknown>>(),
    createdAtMs: integer('created_at_ms').notNull(),
  },
  (t) => [primaryKey({ columns: [t.appId, t.userId, t.key] })],
)

/** Columns added after the first release, for databases created before them (SQLite has no ADD COLUMN IF NOT EXISTS). */
export const ADDED_COLUMNS: { table: string; column: string; type: string }[] = [
  { table: 'requests', column: 'attachments', type: 'TEXT' },
  // Stage 4a (F1, F2, F4, B5)
  { table: 'snapshots', column: 'org_id', type: "TEXT NOT NULL DEFAULT 'default'" },
  { table: 'snapshots', column: 'region', type: "TEXT NOT NULL DEFAULT 'local'" },
  { table: 'snapshots', column: 'environment', type: "TEXT NOT NULL DEFAULT 'development'" },
  { table: 'snapshots', column: 'base_files', type: 'TEXT' },
  { table: 'snapshots', column: 'schema_version', type: 'INTEGER NOT NULL DEFAULT 1' },
  { table: 'heads', column: 'org_id', type: "TEXT NOT NULL DEFAULT 'default'" },
  { table: 'requests', column: 'org_id', type: "TEXT NOT NULL DEFAULT 'default'" },
  { table: 'requests', column: 'region', type: "TEXT NOT NULL DEFAULT 'local'" },
  { table: 'requests', column: 'environment', type: "TEXT NOT NULL DEFAULT 'development'" },
  { table: 'requests', column: 'prompt_version', type: 'TEXT' },
  { table: 'bundle_files', column: 'org_id', type: "TEXT NOT NULL DEFAULT 'default'" },
  // Stage 4b (DECISIONS 44)
  { table: 'requests', column: 'intent_label', type: 'TEXT' },
  { table: 'requests', column: 'gist', type: 'TEXT' },
  { table: 'requests', column: 'retained_at', type: 'TEXT' },
  { table: 'app_settings', column: 'learning', type: 'TEXT' },
]

// Plain DDL so the demo needs no migration tool; keep in sync with the tables above.
export const DDL = `
CREATE TABLE IF NOT EXISTS snapshots (
  id TEXT NOT NULL, app_id TEXT NOT NULL, user_id TEXT NOT NULL, parent_id TEXT, files TEXT NOT NULL,
  message TEXT NOT NULL, author TEXT NOT NULL, created_at TEXT NOT NULL, status TEXT NOT NULL, base_hash TEXT, request_id TEXT,
  org_id TEXT NOT NULL DEFAULT 'default', region TEXT NOT NULL DEFAULT 'local', environment TEXT NOT NULL DEFAULT 'development',
  base_files TEXT, schema_version INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (app_id, id)
);
CREATE INDEX IF NOT EXISTS snapshots_by_user ON snapshots (app_id, user_id, id);
CREATE TABLE IF NOT EXISTS heads (
  app_id TEXT NOT NULL, user_id TEXT NOT NULL, snapshot_id TEXT NOT NULL, updated_at TEXT NOT NULL, org_id TEXT NOT NULL DEFAULT 'default',
  PRIMARY KEY (app_id, user_id)
);
CREATE TABLE IF NOT EXISTS requests (
  id TEXT PRIMARY KEY, app_id TEXT NOT NULL, user_id TEXT NOT NULL, text TEXT NOT NULL, target TEXT, verdict TEXT NOT NULL,
  summary TEXT NOT NULL, status TEXT NOT NULL, classification TEXT, provider TEXT, model TEXT, usage TEXT, timings TEXT,
  log TEXT NOT NULL, files TEXT, snapshot_id TEXT, error TEXT, attachments TEXT, admin_note TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL, org_id TEXT NOT NULL DEFAULT 'default', region TEXT NOT NULL DEFAULT 'local',
  environment TEXT NOT NULL DEFAULT 'development', prompt_version TEXT, intent_label TEXT, gist TEXT, retained_at TEXT
);
CREATE INDEX IF NOT EXISTS requests_by_app ON requests (app_id, created_at_ms);
CREATE TABLE IF NOT EXISTS app_settings (
  app_id TEXT PRIMARY KEY, moderation TEXT NOT NULL, updated_at TEXT NOT NULL, learning TEXT
);
CREATE TABLE IF NOT EXISTS request_facts (
  request_id TEXT PRIMARY KEY, app_id TEXT NOT NULL, org_id TEXT NOT NULL, user_key TEXT NOT NULL, panel_key TEXT, intent_label TEXT,
  verdict TEXT NOT NULL, first_try INTEGER, turns INTEGER NOT NULL, tool_calls INTEGER NOT NULL, cost_usd REAL NOT NULL, latency_ms INTEGER,
  prompt_version TEXT, model TEXT, provider TEXT, compiler_version TEXT, static_rule_hits TEXT NOT NULL, outcome TEXT, learning TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS facts_by_app ON request_facts (app_id, created_at_ms);
CREATE TABLE IF NOT EXISTS app_salts (app_id TEXT PRIMARY KEY, salt TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS agent_runs (
  app_id TEXT NOT NULL, user_id TEXT NOT NULL, key TEXT NOT NULL, state TEXT NOT NULL, result TEXT, created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (app_id, user_id, key)
);
CREATE TABLE IF NOT EXISTS bundle_files (
  app_id TEXT NOT NULL, key TEXT NOT NULL, owner TEXT NOT NULL, js TEXT NOT NULL, css TEXT NOT NULL, signature TEXT, created_at TEXT NOT NULL,
  org_id TEXT NOT NULL DEFAULT 'default',
  PRIMARY KEY (app_id, key, owner)
);
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, ts_ms INTEGER NOT NULL, app_id TEXT NOT NULL, org_id TEXT NOT NULL,
  user_id TEXT, region TEXT NOT NULL, environment TEXT NOT NULL, type TEXT NOT NULL, value REAL NOT NULL, unit TEXT NOT NULL,
  request_id TEXT, source TEXT NOT NULL, dedupe_key TEXT, props TEXT
);
CREATE INDEX IF NOT EXISTS events_by_app ON events (app_id, ts_ms);
CREATE INDEX IF NOT EXISTS events_by_type ON events (app_id, type, ts_ms);
CREATE UNIQUE INDEX IF NOT EXISTS events_dedupe ON events (app_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE TRIGGER IF NOT EXISTS events_append_only_u BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS events_append_only_d BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
CREATE TABLE IF NOT EXISTS audit (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, app_id TEXT NOT NULL, org_id TEXT NOT NULL, ts TEXT NOT NULL, actor TEXT NOT NULL,
  action TEXT NOT NULL, object_type TEXT NOT NULL, object_id TEXT, details TEXT, prev_hash TEXT NOT NULL, hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_by_app ON audit (app_id, seq);
CREATE TRIGGER IF NOT EXISTS audit_append_only_u BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_append_only_d BEFORE DELETE ON audit BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END;
CREATE TABLE IF NOT EXISTS flags (
  app_id TEXT NOT NULL, scope TEXT NOT NULL, scope_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT, updated_at TEXT NOT NULL,
  PRIMARY KEY (app_id, scope, scope_id, key)
);
CREATE TABLE IF NOT EXISTS idempotency (
  app_id TEXT NOT NULL, caller TEXT NOT NULL, key TEXT NOT NULL, method TEXT NOT NULL, path TEXT NOT NULL, body_hash TEXT NOT NULL,
  status INTEGER NOT NULL, body TEXT NOT NULL, content_type TEXT, created_at_ms INTEGER NOT NULL, PRIMARY KEY (app_id, caller, key)
);
CREATE TABLE IF NOT EXISTS quota_buckets (
  app_id TEXT NOT NULL, key TEXT NOT NULL, tokens REAL NOT NULL, updated_ms INTEGER NOT NULL, PRIMARY KEY (app_id, key)
);
CREATE TABLE IF NOT EXISTS app_plans (
  app_id TEXT PRIMARY KEY, plan TEXT NOT NULL, limits TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bundles (
  app_id TEXT NOT NULL, hash TEXT NOT NULL, js TEXT NOT NULL, css TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (app_id, hash)
);
`

/** Run after DDL and ADDED_COLUMNS: snapshots are insert-only (the agent request may be linked once). */
export const SNAPSHOT_TRIGGERS = `
CREATE TRIGGER IF NOT EXISTS snapshots_insert_only BEFORE UPDATE OF id, app_id, user_id, parent_id, files, message, author, created_at, status, base_hash, base_files, schema_version, org_id ON snapshots
BEGIN SELECT RAISE(ABORT, 'snapshots are insert-only'); END;
CREATE TRIGGER IF NOT EXISTS snapshots_link_once BEFORE UPDATE OF request_id ON snapshots WHEN OLD.request_id IS NOT NULL AND OLD.request_id IS NOT NEW.request_id
BEGIN SELECT RAISE(ABORT, 'snapshots are insert-only'); END;
`

/** Databases from before Stage 4b have `id` alone as the primary key of snapshots: rebuild with (app_id, id). */
export const SNAPSHOT_PK_MIGRATION = `
CREATE TABLE snapshots_4b (
  id TEXT NOT NULL, app_id TEXT NOT NULL, user_id TEXT NOT NULL, parent_id TEXT, files TEXT NOT NULL,
  message TEXT NOT NULL, author TEXT NOT NULL, created_at TEXT NOT NULL, status TEXT NOT NULL, base_hash TEXT, request_id TEXT,
  org_id TEXT NOT NULL DEFAULT 'default', region TEXT NOT NULL DEFAULT 'local', environment TEXT NOT NULL DEFAULT 'development',
  base_files TEXT, schema_version INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (app_id, id)
);
INSERT INTO snapshots_4b (id, app_id, user_id, parent_id, files, message, author, created_at, status, base_hash, request_id, org_id, region, environment, base_files, schema_version)
  SELECT id, app_id, user_id, parent_id, files, message, author, created_at, status, base_hash, request_id, org_id, region, environment, base_files, schema_version FROM snapshots;
DROP TABLE snapshots;
ALTER TABLE snapshots_4b RENAME TO snapshots;
CREATE INDEX IF NOT EXISTS snapshots_by_user ON snapshots (app_id, user_id, id);
`
