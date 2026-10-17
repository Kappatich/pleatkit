import { index, primaryKey, sqliteTable, text, integer } from 'drizzle-orm/sqlite-core'

/** A full snapshot of one user's dynamic zone (same shape as `Snapshot` in @morphkit/runtime, plus appId). */
export const snapshots = sqliteTable(
  'snapshots',
  {
    id: text('id').primaryKey(),
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
  },
  (t) => [index('snapshots_by_user').on(t.appId, t.userId, t.id)],
)

export const heads = sqliteTable(
  'heads',
  {
    appId: text('app_id').notNull(),
    userId: text('user_id').notNull(),
    snapshotId: text('snapshot_id').notNull(),
    updatedAt: text('updated_at').notNull(),
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
    /** proposed | applied | pending-review | rejected | pending-admin | in-progress | rolled-back | failed */
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

/** Per-app settings an admin can change at runtime (moderation of agent edits). */
export const appSettings = sqliteTable('app_settings', {
  appId: text('app_id').primaryKey(),
  /** off | review */
  moderation: text('moderation').notNull(),
  updatedAt: text('updated_at').notNull(),
})

/** Columns added after the first release, for databases created before them (SQLite has no ADD COLUMN IF NOT EXISTS). */
export const ADDED_COLUMNS: { table: string; column: string; type: string }[] = [{ table: 'requests', column: 'attachments', type: 'TEXT' }]

// Plain DDL so the demo needs no migration tool; keep in sync with the tables above.
export const DDL = `
CREATE TABLE IF NOT EXISTS snapshots (
  id TEXT PRIMARY KEY, app_id TEXT NOT NULL, user_id TEXT NOT NULL, parent_id TEXT, files TEXT NOT NULL,
  message TEXT NOT NULL, author TEXT NOT NULL, created_at TEXT NOT NULL, status TEXT NOT NULL, base_hash TEXT, request_id TEXT
);
CREATE INDEX IF NOT EXISTS snapshots_by_user ON snapshots (app_id, user_id, id);
CREATE TABLE IF NOT EXISTS heads (
  app_id TEXT NOT NULL, user_id TEXT NOT NULL, snapshot_id TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (app_id, user_id)
);
CREATE TABLE IF NOT EXISTS requests (
  id TEXT PRIMARY KEY, app_id TEXT NOT NULL, user_id TEXT NOT NULL, text TEXT NOT NULL, target TEXT, verdict TEXT NOT NULL,
  summary TEXT NOT NULL, status TEXT NOT NULL, classification TEXT, provider TEXT, model TEXT, usage TEXT, timings TEXT,
  log TEXT NOT NULL, files TEXT, snapshot_id TEXT, error TEXT, attachments TEXT, admin_note TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS requests_by_app ON requests (app_id, created_at_ms);
CREATE TABLE IF NOT EXISTS app_settings (
  app_id TEXT PRIMARY KEY, moderation TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bundles (
  app_id TEXT NOT NULL, hash TEXT NOT NULL, js TEXT NOT NULL, css TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (app_id, hash)
);
`
