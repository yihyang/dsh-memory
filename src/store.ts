/**
 * SQLite-backed memory store: a plain `memories` table with an external-content
 * FTS5 index kept in sync by triggers. Owned entirely by this package — the
 * harness's own SQLite backends index sessions, not durable user facts.
 * @module dsh-memory/store
 */

import { chmodSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/** Monotonic on-disk schema version; a mismatch rebuilds the derived index. */
export const SCHEMA_VERSION = 1

/** One stored memory as tools and the prompt section see it. */
export interface MemoryRecord {
  id: number
  text: string
  /** Normalized, space-joined tag list; empty string when untagged. */
  tags: string
  /** Pinned memories always render in the prompt section, ahead of recent ones. */
  pinned: boolean
  createdAt: number
  updatedAt: number
}

/** A search hit: the record plus its FTS rank (lower is a better match). */
export interface MemoryMatch extends MemoryRecord {
  rank: number
}

/** One append-only audit row: what happened to a memory, not its content. */
export interface AuditEntry {
  id: number
  memoryId: number
  action: 'write' | 'forget'
  /**
   * SHA-256 hex of the memory text at the time of the action — never the text
   * itself. This is a correlation/integrity token, not a confidentiality
   * boundary: memory text is short natural language, not high-entropy
   * secret material, so an investigator (or anyone who can read this table)
   * with a list of candidate strings can confirm which ones were stored by
   * hashing each candidate and comparing.
   */
  textHash: string
  tags: string
  pinned: boolean
  at: number
}

/** Row shape returned by the statements below, before field-name and boolean normalization. */
interface MemoryRow {
  id: number
  text: string
  tags: string
  pinned: number
  created_at: number
  updated_at: number
  rank?: number
}

/** Row shape for `memories_audit`, before field-name and boolean normalization. */
interface AuditRow {
  id: number
  memory_id: number
  action: string
  text_hash: string
  tags: string
  pinned: number
  at: number
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT NOT NULL,
    tags TEXT NOT NULL DEFAULT '',
    pinned INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS memories_recent ON memories (updated_at DESC, id DESC);
  CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts
    USING fts5(text, tags, content='memories', content_rowid='id');
  CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
    INSERT INTO memories_fts (rowid, text, tags) VALUES (new.id, new.text, new.tags);
  END;
  CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
    INSERT INTO memories_fts (memories_fts, rowid, text, tags) VALUES ('delete', old.id, old.text, old.tags);
  END;
  CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
    INSERT INTO memories_fts (memories_fts, rowid, text, tags) VALUES ('delete', old.id, old.text, old.tags);
    INSERT INTO memories_fts (rowid, text, tags) VALUES (new.id, new.text, new.tags);
  END;
  CREATE TABLE IF NOT EXISTS memories_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    memory_id INTEGER NOT NULL,
    action TEXT NOT NULL,
    text_hash TEXT NOT NULL,
    tags TEXT NOT NULL DEFAULT '',
    pinned INTEGER NOT NULL DEFAULT 0,
    at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS memories_audit_memory_id ON memories_audit (memory_id, at);
`

/**
 * Normalize a tag list to the lowercase, deduplicated, space-joined form the
 * FTS index stores, so `Foo`, `foo`, and a repeated `foo` all match `foo`.
 * @param tags - tags as supplied by the model or config.
 * @returns the normalized space-joined list, empty when nothing survives.
 */
export function normalizeTags(tags: readonly string[]): string {
  const seen = new Set<string>()
  for (const tag of tags) {
    const normalized = tag.trim().toLowerCase().replaceAll(/\s+/g, '-')
    if (normalized.length > 0) seen.add(normalized)
  }
  return [...seen].join(' ')
}

/**
 * Compile a free-text query into an FTS5 MATCH expression. Every token is
 * quoted, so FTS5 operators a model happens to type (`OR`, `*`, `-`, `"`) are
 * matched literally instead of changing the query's meaning or raising a
 * syntax error mid-tool-call.
 * @param query - the raw query text.
 * @returns the MATCH expression, or undefined when the query has no usable token.
 */
export function compileMatch(query: string): string | undefined {
  const tokens = query
    .split(/[^\p{L}\p{N}_]+/u)
    .filter(token => token.length > 0)
    .map(token => `"${token}"`)
  return tokens.length > 0 ? tokens.join(' ') : undefined
}

/** Map one row to the record shape, converting SQLite's integer boolean. */
function toRecord(row: MemoryRow): MemoryRecord {
  return {
    id: row.id,
    text: row.text,
    tags: row.tags,
    pinned: row.pinned !== 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/** Map one row to the audit entry shape, converting SQLite's integer boolean. */
function toAuditEntry(row: AuditRow): AuditEntry {
  return {
    id: row.id,
    memoryId: row.memory_id,
    action: row.action as AuditEntry['action'],
    textHash: row.text_hash,
    tags: row.tags,
    pinned: row.pinned !== 0,
    at: row.at,
  }
}

/** SHA-256 hex digest of a memory's text, for the audit trail — never the text itself. */
function hashText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

// Common credential shapes: cloud/VCS/chat tokens, PEM private keys, JWTs.
// Best-effort — this is a guardrail against the common accidental paste, not a
// secret scanner, so it stays a short, low-false-positive list.
const SECRET_PATTERNS: readonly RegExp[] = [
  /\b(?:AKIA|ASIA|AIDA|AROA)[0-9A-Z]{16}\b/, // AWS access key id (long-term, STS, IAM user, role)
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/, // GitHub token (classic)
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/, // GitHub fine-grained PAT
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, // Slack token
  // OpenAI/Anthropic-style secret key. Real keys are not pure alphanumeric —
  // Anthropic uses `sk-ant-api03-…`, OpenAI project keys use `sk-proj-…` —
  // so the body must allow the hyphens and underscores those shapes contain,
  // not just the legacy `sk-<alnum>` form.
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}\b/,
  /\b(?:sk|pk)_live_[A-Za-z0-9]{10,}\b/, // Stripe live key
  /\bAIza[0-9A-Za-z_-]{35}\b/, // Google API key
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA |)PRIVATE KEY-----/, // PEM private key
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/, // JWT
]

/**
 * Whether text contains a recognizable credential shape (cloud/VCS/chat
 * token, PEM private key, JWT). A guardrail against the common accidental
 * paste, not a guarantee of catching every secret.
 * @param text - the candidate memory text.
 * @returns true when a known secret shape is found.
 */
export function looksLikeSecret(text: string): boolean {
  return SECRET_PATTERNS.some(pattern => pattern.test(text))
}

/**
 * Restrict the WAL/SHM siblings created lazily by `journal_mode=WAL` to the
 * owning user. Best-effort: called once they are expected to exist, but a
 * driver that defers their creation further could still race this.
 * @param path - the database file path.
 */
function restrictSiblingsToOwner(path: string): void {
  for (const suffix of ['-wal', '-shm']) {
    try {
      chmodSync(path + suffix, 0o600)
    } catch (error) {
      // Only "not created yet" is expected and swallowed here — anything
      // else (EACCES, EPERM, ...) means the hardening this function exists
      // for actually failed, so it must surface rather than go silent.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
}

/**
 * The durable memory store. One instance owns one SQLite connection; `close()`
 * is idempotent and runs from the plugin's disposer.
 */
export class MemoryStore {
  readonly #db: DatabaseSync
  #closed = false

  /**
   * Open (creating if absent) the store at `path`, applying the schema.
   * @param path - database file path, or `:memory:` for an ephemeral store.
   */
  constructor(path: string) {
    // Lock the directory down *before* the file exists in it, and the file
    // immediately after creation — before schema or pragma writes touch it —
    // so there is no window where the store holds real content at a
    // world/group-readable path or mode.
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
      chmodSync(dirname(path), 0o700)
    }
    this.#db = new DatabaseSync(path)
    if (path !== ':memory:') chmodSync(path, 0o600)
    this.#db.exec('PRAGMA journal_mode = WAL')
    this.#db.exec('PRAGMA foreign_keys = ON')
    // Overwrite deleted rows' bytes on disk instead of leaving them in freed
    // pages, so memory_forget on a mistakenly-stored secret actually scrubs it.
    // secure_delete only covers the main file, though — forget() below also
    // checkpoints and truncates the WAL, which otherwise retains a pre-delete
    // copy of the row until the connection closes.
    this.#db.exec('PRAGMA secure_delete = ON')
    this.#db.exec(SCHEMA)
    this.#db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
    if (path !== ':memory:') restrictSiblingsToOwner(path)
  }

  /**
   * Store one memory.
   * @param text - the fact to remember.
   * @param tags - normalized tag list.
   * @param pinned - whether it always renders in the prompt section.
   * @returns the new record.
   */
  write(text: string, tags: string, pinned: boolean): MemoryRecord {
    const now = Date.now()
    return this.#transaction(() => {
      const statement = this.#db.prepare(
        'INSERT INTO memories (text, tags, pinned, created_at, updated_at) VALUES (?, ?, ?, ?, ?) RETURNING *')
      const record = toRecord(statement.get(text, tags, pinned ? 1 : 0, now, now) as unknown as MemoryRow)
      this.#audit(record.id, 'write', text, tags, pinned, now)
      return record
    })
  }

  /**
   * Full-text search over memory text and tags, best match first.
   * @param query - free-text query; FTS operators in it are matched literally.
   * @param limit - maximum hits to return.
   * @returns the ranked matches, empty when the query has no usable token.
   */
  search(query: string, limit: number): MemoryMatch[] {
    const match = compileMatch(query)
    if (match === undefined) return []
    const rows = this.#db.prepare(`
      SELECT m.*, memories_fts.rank AS rank
      FROM memories_fts JOIN memories m ON m.id = memories_fts.rowid
      WHERE memories_fts MATCH ? ORDER BY rank LIMIT ?
    `).all(match, limit) as unknown as MemoryRow[]
    return rows.map(row => ({ ...toRecord(row), rank: row.rank ?? 0 }))
  }

  /**
   * The memories the prompt section renders: pinned first, then most recently
   * updated, with no record repeated.
   * @param recentCount - how many unpinned recent memories to include.
   * @returns pinned records followed by recent ones.
   */
  forPrompt(recentCount: number): MemoryRecord[] {
    // `id DESC` breaks the tie: several memories written in the same
    // millisecond share an `updated_at`, and without it their relative order
    // is whatever the planner returns rather than newest-first.
    const pinned = this.#db.prepare(
      'SELECT * FROM memories WHERE pinned = 1 ORDER BY updated_at DESC, id DESC').all() as unknown as MemoryRow[]
    const recent = this.#db.prepare(
      'SELECT * FROM memories WHERE pinned = 0 ORDER BY updated_at DESC, id DESC LIMIT ?')
      .all(recentCount) as unknown as MemoryRow[]
    return [...pinned, ...recent].map(toRecord)
  }

  /**
   * Delete one memory.
   * @param id - the record id.
   * @returns whether a record was deleted.
   */
  forget(id: number): boolean {
    const row = this.#db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as unknown as MemoryRow | undefined
    if (!row) return false
    this.#transaction(() => {
      this.#db.prepare('DELETE FROM memories WHERE id = ?').run(id)
      this.#audit(row.id, 'forget', row.text, row.tags, row.pinned !== 0, Date.now())
    })
    // secure_delete zeroes the row's bytes in the main file, but under WAL
    // mode a pre-delete copy still sits in the -wal file until it is
    // checkpointed. TRUNCATE both flushes it into the (now-zeroed) main file
    // and truncates the WAL back to empty, so a forgotten secret does not sit
    // recoverable on disk for the rest of the process's lifetime. Run after
    // the transaction commits — checkpointing mid-transaction cannot flush
    // the frames that transaction itself is still writing.
    this.#db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    return true
  }

  /**
   * The append-only history of writes and forgets, most recent first. Text is
   * never stored — only its hash — so the trail can confirm what happened
   * without duplicating the risk it exists to help investigate.
   * @param limit - maximum entries to return.
   * @returns the audit entries.
   */
  auditLog(limit: number): AuditEntry[] {
    const rows = this.#db.prepare(
      'SELECT * FROM memories_audit ORDER BY at DESC, id DESC LIMIT ?').all(limit) as unknown as AuditRow[]
    return rows.map(toAuditEntry)
  }

  /** Append one audit row. Never persists the memory text — only its hash. */
  #audit(memoryId: number, action: AuditEntry['action'], text: string, tags: string, pinned: boolean, at: number): void {
    this.#db.prepare(
      'INSERT INTO memories_audit (memory_id, action, text_hash, tags, pinned, at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(memoryId, action, hashText(text), tags, pinned ? 1 : 0, at)
  }

  /**
   * Run `fn` inside an explicit transaction, so a mutation and its audit row
   * commit or fail together. Without this, a mid-air failure (disk full,
   * corruption) between the two statements could leave the live table
   * mutated with no audit entry, or vice versa — exactly the failure the
   * audit trail exists to help diagnose.
   * @param fn - the statements to run atomically.
   * @returns whatever `fn` returns.
   */
  #transaction<T>(fn: () => T): T {
    this.#db.exec('BEGIN')
    try {
      const result = fn()
      this.#db.exec('COMMIT')
      return result
    } catch (error) {
      this.#db.exec('ROLLBACK')
      throw error
    }
  }

  /**
   * Total stored memories.
   * @returns the row count.
   */
  count(): number {
    const row = this.#db.prepare('SELECT COUNT(*) AS n FROM memories').get() as unknown as { n: number }
    return row.n
  }

  /** Close the connection; idempotent, so plugin disposal and tests may both call it. */
  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.#db.close()
  }
}
