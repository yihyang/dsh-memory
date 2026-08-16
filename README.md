# dsh-memory

> This is a fork of [ben7am1n/dsh-memory](https://github.com/ben7am1n/dsh-memory). All credit for the original design and implementation goes to the upstream author — see [Changes in this fork](#changes-in-this-fork) for what's different here.

Durable cross-session memory for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

The harness ships no memory plugin. Its `extension-cookbook` names the mechanism — a prompt section plus tools — but nothing implements it, so every session starts blank. This package fills that gap with one local SQLite file: **no embedding service, no API key, no sidecar process.**

## Install

```bash
dsh plugin --profile web add dsh-memory
```

The shipped bundle row stores memories at `$DSH_HOME/memory/memory.db`, shared by every profile on the machine.

## What it gives the model

| Tool | Purpose |
|---|---|
| `memory_write` | Store one self-contained durable fact, optionally tagged and pinned |
| `memory_search` | Keyword search over memory text and tags |
| `memory_forget` | Delete a memory that is now wrong or obsolete |

Plus a `memory:recall` prompt section that renders **pinned memories first, then the most recently updated**, under a character budget. Recall therefore does not depend on the model remembering to search — what it stored is already in front of it, and search is for anything older than the budget allows.

The rendered section and `memory_search` results are explicitly framed as **data, not instructions** — wrapped in `<stored_memories>` tags with a header stating their content does not override the model's instructions. A memory that a compromised or tricked session managed to write cannot pose as system guidance just by being read back on a later turn.

The `memory_write` description steers the model away from the common failure modes: transient task state (that is what the todo list is for), secrets, and facts the repository already records. Text matching a recognizable credential shape (API key, token, PEM private key, JWT) is **rejected automatically**, not just discouraged by the description.

## Configuration

```yaml
- id: memory
  name: dsh-memory
  config:
    path: !!js dshHomePath('memory/memory.db')
    promptRecentCount: 10
    promptMaxChars: 2000
    maxTextChars: 2000
    searchLimitDefault: 10
    searchLimitMax: 50
    promptOrder: 50
    maxRecords: 5000
```

| Field | Default | Meaning |
|---|---|---|
| `path` | — (required) | SQLite file, or `:memory:` for an ephemeral store |
| `promptRecentCount` | `10` | Unpinned recent memories offered to the prompt section |
| `promptMaxChars` | `2000` | Budget for the rendered section; overflow is reported as a count, and pinned memories are emitted first so they survive a tight budget |
| `maxTextChars` | `2000` | Maximum characters accepted for one memory |
| `searchLimitDefault` | `10` | `memory_search` limit when the model omits it |
| `searchLimitMax` | `50` | Hard cap, whatever the model asks for |
| `promptOrder` | `50` | Section order; `-100` is the harness identity, `0` the persona |
| `maxRecords` | `5000` | Hard cap on total stored memories; `memory_write` is refused past it rather than growing the store unbounded |

`path` has **no code-side default on purpose**: a default would scatter durable user facts into whatever directory the harness happened to start in. The deployment value lives in the patch row.

## Storage

One SQLite file: a `memories` table plus an external-content FTS5 index kept in sync by triggers. Parent directories are created on open, and the store survives process restarts.

Search compiles the query by **quoting every token**, so FTS5 operators a model happens to type (`OR`, `*`, `-`, `"`) are matched literally instead of changing the query's meaning or raising a syntax error mid-tool-call. Surviving tokens combine with FTS5's implicit AND: every token must appear, and a query whose tokens include a word you did not store legitimately matches nothing.

`node:sqlite` is still flagged experimental in Node 22/24, so running the harness prints one `ExperimentalWarning`. The harness's own `dsh-session-query-sqlite` uses the same module.

### Hardening

- **File permissions.** The directory is created (and `chmod`'d) owner-only before the database file exists in it, and the file is `chmod`'d to `0600` immediately after creation, before any schema or pragma write — so there is no window where real content sits at a world/group-readable path or mode. The `-wal`/`-shm` siblings are locked down as soon as `journal_mode=WAL` has had a chance to create them. This is POSIX permission bits; on Windows `chmod` only toggles the read-only attribute and does not enforce equivalent per-user access control.
- **Secure delete.** The store runs with `PRAGMA secure_delete = ON`, so `memory_forget` zeroes the deleted row's bytes in the main file. Under WAL mode a pre-delete copy can still sit in the `-wal` file until checkpointed, so `forget()` also runs `PRAGMA wal_checkpoint(TRUNCATE)` right after the delete — flushing and truncating the WAL so nothing recoverable is left on disk for the rest of the process's lifetime.
- **Audit trail.** Every `write` and `forget` appends a row to an internal `memories_audit` table — action, timestamp, tags, and a SHA-256 hash of the text, never the text itself. The hash is a correlation/integrity token, not a confidentiality boundary: memory text is short natural language, not high-entropy secret material, so it doesn't resist a dictionary-style attack against candidate strings.
- **Prompt-boundary escaping.** `<` and `>` in stored text and tags are replaced with inert lookalikes (`‹`/`›`) before rendering, so a memory can never forge a `</stored_memories>` closing tag (or any other structural markup) to break out of the data framing above.

None of this is a substitute for disk-level encryption on a shared machine, and the secret check is a guardrail, not a scanner — treat this store the way you'd treat any other local plaintext file that might end up holding something sensitive.

## Failure behavior

Load-time misconfiguration fails loud: an empty `path`, a non-positive bound, or a `searchLimitDefault` above `searchLimitMax` throws at plugin load.

At call time, a blank fact, one over `maxTextChars`, or one matching a recognizable credential shape is a tool error the model can correct. A `memory_write` past `maxRecords` is refused the same way. A `memory_forget` for an id that does not exist is a **successful** result reporting `forgotten: false` — the model asked for a state that already holds, which is not an infrastructure failure.

## Extension points

`ctx.tools.register()` for the three tools and `ctx.systemPrompt.section()` for recall. Every registration is a Cordis effect, so unloading the plugin removes the tools and the section together and closes the database.

## Development

```bash
pnpm install --ignore-workspace
pnpm run typecheck
pnpm test
pnpm run build
```

Tests cover the store directly (FTS retrieval, the literal-token query contract, prompt ordering, durability across reopens) and the plugin against the **real** tool registry and prompt service (registration, disposal, the write→recall round trip, bounds, fail-loud config).

## Changes in this fork

Everything above describes the plugin as it stands here. Relative to upstream [ben7am1n/dsh-memory](https://github.com/ben7am1n/dsh-memory), this fork adds a security-hardening pass — all of it in the two files upstream defines the plugin in, none of it a redesign:

- **Prompt-injection framing.** The `memory:recall` section and `memory_search` results are wrapped in `<stored_memories>` tags with a header stating the content is data, not instructions, and does not override the model's own instructions. `<`/`>` in stored text and tags are escaped to inert lookalikes so a memory can't forge a closing tag to break out of that framing.
- **Secret rejection.** `memory_write` rejects text or tags matching a recognizable credential shape (AWS/GitHub/Slack/OpenAI/Stripe/Google keys, PEM private key headers, JWTs) before it's ever persisted.
- **Secure delete.** The store runs with `PRAGMA secure_delete = ON`, and `memory_forget` also checkpoints and truncates the WAL, so a forgotten memory doesn't stay recoverable on disk for the rest of the process's lifetime.
- **File permissions.** The database file, its `-wal`/`-shm` siblings, and the containing directory are locked to owner-only (`0600`/`0700`), with the ordering chosen to close the window where a default-permission file could hold real content.
- **Audit trail.** An internal `memories_audit` table records every write and forget — action, timestamp, tags, and a hash of the text, never the text itself — so a poisoning incident can be reconstructed after the fact.
- **`maxRecords` bound.** A new config field caps total stored memories, so `memory_write` fails loud instead of growing the store without limit.

See [Hardening](#hardening) above for the detail on each.

## License

MIT

## Prior art

The idea comes from [pi-mentis](https://github.com/guchengod/pi-mentis) (MIT) in the Pi ecosystem — credit belongs to upstream for this framing, not to this fork. This is an independent implementation against Harness extension points and shares no code with it. It deliberately drops pi-mentis's sidecar process, Zvec vector store, and required SiliconFlow embedding key in favour of one local FTS5 file — smaller, keyless, and offline, at the cost of lexical rather than semantic retrieval.
