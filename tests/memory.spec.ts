import { existsSync, readFileSync, statSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MemoryStore, compileMatch, looksLikeSecret, normalizeTags } from '../src/store.ts'

/**
 * Behavior suite for the memory store: FTS retrieval, the literal-token query
 * contract, prompt selection ordering, and durability across reopens. The
 * store is the whole risk surface — the plugin layer above it is registration
 * plus bounds, both covered by config.spec.ts.
 */

const scratch: string[] = []

/** A store on a fresh temporary file, tracked for cleanup. */
async function fileStore(): Promise<{ store: MemoryStore; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-memory-'))
  scratch.push(dir)
  const path = join(dir, 'nested', 'memory.db')
  return { store: new MemoryStore(path), path }
}

afterEach(async () => {
  await Promise.all(scratch.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('write and search', () => {
  it('finds a memory by a word from its text', () => {
    const store = new MemoryStore(':memory:')
    store.write('The build uses pnpm, never npm', '', false)
    store.write('Deploys run from the release branch', '', false)

    expect(store.search('pnpm', 10).map(match => match.text)).toEqual(['The build uses pnpm, never npm'])
    store.close()
  })

  it('finds a memory by tag', () => {
    const store = new MemoryStore(':memory:')
    store.write('Prefers dark mode', normalizeTags(['preference', 'ui']), false)
    store.write('Uses tabs', normalizeTags(['style']), false)

    expect(store.search('preference', 10)).toHaveLength(1)
    store.close()
  })

  it('honours the limit', () => {
    const store = new MemoryStore(':memory:')
    for (let index = 0; index < 5; index++) store.write(`fact about widgets number ${index}`, '', false)

    expect(store.search('widgets', 3)).toHaveLength(3)
    store.close()
  })

  it('returns nothing for a query with no usable token', () => {
    const store = new MemoryStore(':memory:')
    store.write('anything', '', false)

    expect(store.search('   ***   ', 10)).toEqual([])
    store.close()
  })
})

describe('query compilation', () => {
  it('quotes every token so FTS operators are matched literally', () => {
    expect(compileMatch('build OR deploy')).toBe('"build" "OR" "deploy"')
  })

  it('drops punctuation rather than emitting invalid FTS syntax', () => {
    expect(compileMatch('foo-bar "baz"')).toBe('"foo" "bar" "baz"')
  })

  it('reports an unusable query instead of guessing', () => {
    expect(compileMatch('!!! ???')).toBeUndefined()
  })

  it('survives a query that would otherwise be an FTS syntax error', () => {
    const store = new MemoryStore(':memory:')
    store.write('a note about parentheses', '', false)

    // Punctuation is dropped, and the surviving tokens combine with FTS5's
    // implicit AND — so every token must appear, and a stray word legitimately
    // matches nothing. Neither case may raise a syntax error mid-tool-call.
    expect(() => store.search('note )(" AND', 10)).not.toThrow()
    expect(store.search('note )(" parentheses', 10)).toHaveLength(1)
    expect(store.search('note )(" absent', 10)).toEqual([])
    store.close()
  })
})

describe('tag normalization', () => {
  it('lowercases, deduplicates, and hyphenates', () => {
    expect(normalizeTags(['Build', 'build', 'CI  Pipeline'])).toBe('build ci-pipeline')
  })

  it('drops blank tags', () => {
    expect(normalizeTags(['  ', '', 'ok'])).toBe('ok')
  })
})

describe('prompt selection', () => {
  it('puts pinned memories first, then the most recent', () => {
    const store = new MemoryStore(':memory:')
    store.write('oldest', '', false)
    store.write('newest', '', false)
    store.write('always', '', true)

    expect(store.forPrompt(10).map(record => record.text)).toEqual(['always', 'newest', 'oldest'])
    store.close()
  })

  it('bounds only the unpinned recent list', () => {
    const store = new MemoryStore(':memory:')
    store.write('pin one', '', true)
    store.write('pin two', '', true)
    for (let index = 0; index < 5; index++) store.write(`recent ${index}`, '', false)

    const records = store.forPrompt(2)
    expect(records.filter(record => record.pinned)).toHaveLength(2)
    expect(records.filter(record => !record.pinned)).toHaveLength(2)
    store.close()
  })
})

describe('forget', () => {
  it('removes the record and its index entry', () => {
    const store = new MemoryStore(':memory:')
    const record = store.write('transient detail', '', false)

    expect(store.forget(record.id)).toBe(true)
    expect(store.search('transient', 10)).toEqual([])
    expect(store.count()).toBe(0)
    store.close()
  })

  it('reports a miss rather than throwing', () => {
    const store = new MemoryStore(':memory:')
    expect(store.forget(9999)).toBe(false)
    store.close()
  })
})

describe('secret detection', () => {
  it('flags common credential shapes', () => {
    expect(looksLikeSecret('AWS key AKIAABCDEFGHIJKLMNOP in the deploy script')).toBe(true)
    expect(looksLikeSecret('token: ghp_abcdefghijklmnopqrstuvwxyz0123456789')).toBe(true)
    expect(looksLikeSecret('sk-abcdefghijklmnopqrstuvwx')).toBe(true)
    expect(looksLikeSecret('-----BEGIN RSA PRIVATE KEY-----\nMIIB...')).toBe(true)
    expect(looksLikeSecret('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U')).toBe(true)
  })

  it('leaves ordinary facts alone', () => {
    expect(looksLikeSecret('The user prefers pnpm over npm')).toBe(false)
    expect(looksLikeSecret('Release branch is called ship')).toBe(false)
  })
})

describe('audit trail', () => {
  it('records a write without persisting the raw text', () => {
    const store = new MemoryStore(':memory:')
    const record = store.write('a durable fact', 'build', false)

    const log = store.auditLog(10)
    expect(log).toHaveLength(1)
    expect(log[0]).toMatchObject({ memoryId: record.id, action: 'write', tags: 'build', pinned: false })
    expect(log[0]?.textHash).not.toContain('a durable fact')
    expect(log[0]?.textHash).toMatch(/^[0-9a-f]{64}$/)
    store.close()
  })

  it('records a forget only when a record actually existed', () => {
    const store = new MemoryStore(':memory:')
    const record = store.write('temporary', '', false)

    expect(store.forget(9999)).toBe(false)
    expect(store.forget(record.id)).toBe(true)

    const log = store.auditLog(10)
    expect(log.map(entry => entry.action)).toEqual(['forget', 'write'])
    store.close()
  })
})

describe('forgetting scrubs the WAL, not just the main file', () => {
  it('leaves no recoverable trace in the -wal file after forget, while the connection is still open', async () => {
    const { store, path } = await fileStore()
    const marker = 'UNIQUE-MARKER-do-not-leak-01234567890123456789'
    const record = store.write(marker, '', false)
    store.forget(record.id)

    for (const file of [path, `${path}-wal`, `${path}-shm`]) {
      if (!existsSync(file)) continue
      expect(readFileSync(file).includes(marker)).toBe(false)
    }
    store.close()
  })
})

describe('file permissions', () => {
  it('restricts the database file and its directory to the owner', async () => {
    const { store, path } = await fileStore()
    store.write('anything', '', false)

    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(statSync(dirname(path)).mode & 0o777).toBe(0o700)
    store.close()
  })
})

describe('durability', () => {
  it('creates missing parent directories and survives a reopen', async () => {
    const { store, path } = await fileStore()
    store.write('persisted across restarts', normalizeTags(['durable']), true)
    store.close()

    const reopened = new MemoryStore(path)
    expect(reopened.count()).toBe(1)
    expect(reopened.search('persisted', 10)[0]?.pinned).toBe(true)
    expect(reopened.forPrompt(5)[0]?.text).toBe('persisted across restarts')
    reopened.close()
  })

  it('closes idempotently', () => {
    const store = new MemoryStore(':memory:')
    store.close()
    expect(() => store.close()).not.toThrow()
  })
})
