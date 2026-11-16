# dsh-usage-report

A `/usage` command for DeepSeek Harness that reports token usage for the current
session **together with every subagent session below it**.

DSH's `tokenUsage` projection is per-session: a parent log never mentions the
tokens its children spent, so the chat UI shows only the main agent and a
delegation-heavy turn looks cheaper than it was. This command walks the session
lineage and folds every descendant.

```
Token usage — session example-4f2c1a…

session                            total      input   output     cache-r  cache-w    hit  model
example-4f2c1a… (current)     36,000,000  1,200,000  320,000  34,480,000        0  96.6%  example-model-pro
  Survey repository layout     8,120,441    210,338   71,206   7,838,897        0  97.4%  example-model-flash
  Draft migration plan         5,004,212    180,904   52,880   4,770,428        0  96.3%  example-model-flash
  Review error handling        2,318,077     64,110   20,003   2,233,964        0  97.2%  example-model-flash
  + 9 more subagent sessions   9,208,904    360,112   96,410   8,752,382        0  96.0%  —

Main: 36,000,000   Subagents: 24,651,634   Total: 60,651,634 tok   (13 sessions)
Showing the 12 most expensive subagent sessions; /usage all for the full list.
```

`/usage` prints the root, the twelve most expensive children, and one aggregate row
for the rest. `/usage all` prints every descendant.

## Install

```sh
ln -s /path/to/dsh-usage-report ~/.dsh/profiles/web/node_modules/dsh-usage-report
```

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- insert:
    - id: usage-report
      name: "dsh-usage-report"
```

The plugin has no dependencies and imports nothing from the host, so the symlink
is the whole installation.

`patchReload: live` mounts the row without a restart. A changed plugin **file** is
only picked up when the row itself is recomposed — the HMR watcher does not
follow a symlink out of the profile, but dropping and re-adding the row evicts
the module cache and imports the file again.

Mounting the plugin also warms the session corpus 20 s later, so the first
`/usage` is not the one that pays for the first corpus listing
(`config: { warmAfterMs: 0 }` disables that warm-up).

## Why a 400-child family is fast

Every row is answered from a projection, in two tiers:

1. **Live** — the running agent's own `snapshot()` of `tokenUsage`, `subagent`,
   and `modelSelection`.
2. **Checkpoint** — the durable projection cache at
   `$DSH_HOME/storages/session_projcache`, read with `cachedSnapshot()`. A
   finished session's checkpoint already carries its final totals, its
   `subagent/descriptor` label, and its last served model, so **no log is
   opened**.
3. **Log replay, 8 at a time** — only a session with no usable checkpoint; the
   replay yields the same three values plus the folded totals.

Measured on a 419-session family (402 direct children) over a corpus of 1,357
stored sessions, after the corpus warm-up:

| Case | Time | Log replays |
|---|---|---|
| `/usage` (top 12) | 0.15 s | 0 |
| `/usage all` | 0.14 s | 0 |
| `/usage` before the corpus is warm | 6.0 s | 0 |

The 6.0 s is the first corpus listing of a process — `listSessions()` and
`traceSession()` both pay it once, because listing reads every stored session
header. The background warm-up moves that cost off the command.

## When a family is slow: stale checkpoint formats

The checkpoint tier only answers for a session whose stored checkpoint matches
its **current format version**. `SessionProjectionCache.cachedSnapshot` rejects a
record whose `formatVersion` differs from the listed header's:

```js
function currentLifecycleMatches(stored, expected) {
  return stored.formatVersion === expected.formatVersion && …
}
```

A predecessor tolerance exists (`predecessorIdentityMatches`) but is deliberately
limited to the title projection: format normalization can change what the other
projections mean, so their predecessor records are not served. A session written
before a format migration therefore has an unusable checkpoint and takes the log
replay path.

Measured on a 733-session family in which 315 children still carried
pre-migration checkpoints:

| Work | Time |
|---|---|
| `/usage` end to end | 210 s |
| 417 checkpoint hits | 20 ms total |
| 315 log replays | ~470 ms each |

A replay is CPU-bound, so raising the concurrency does not help: the same 12
sessions took 5.66 s serially, 5.60 s at 8 in flight, and 5.37 s at 16. Most of
each replay is validation and deep cloning rather than decompression — the same
15.5 MB log costs 240 ms to decompress and parse directly
(`zstdDecompressSync` 77 ms, line split 70 ms, `JSON.parse` 93 ms) against
1,416 ms through `readSession`.

This plugin does not bypass that. Reading the storage files directly would trade
the replay guarantee — validated, format-translated events — for speed, and a
later format change could then produce silently wrong totals. The cure is
current checkpoints: opening a session once makes DSH rewrite its checkpoint in
the current format, after which the row costs microseconds.

## What the columns mean

| Column | Meaning |
|---|---|
| `total` | Sum of the four buckets below |
| `input` | Prompt tokens the provider did not serve from cache |
| `output` | Completion tokens |
| `cache-r` | Prompt tokens served from the provider's cache |
| `cache-w` | Prompt tokens written to the cache |
| `hit` | `cache-r ÷ (input + cache-r + cache-w)`, the prompt-side cache hit rate |
| `model` | Model named by the session's `modelSelection` projection |

Rows are indented by delegation depth. The label comes from the child's
`subagent` projection — the same descriptor the subagent catalog shows.

## Where the numbers come from

- A **live** session answers from the `tokenUsage` projection its running agent
  already folds — exact, no I/O.
- A finished session answers from its checkpoint, which ends where the session
  ended.
- A session with no checkpoint is replayed from its persisted log. That fold
  replicates `@deepseek-ai/dsh-token-meter`'s `tokenUsage` unit exactly, including
  the retry-replacement slot, so all three sources agree event for event.

Verified against the durable projection cache on two sessions; the folded
buckets and the cached buckets matched to the token.

## Limits

- The first corpus listing in a process costs seconds on a large history; the
  warm-up hides it unless `/usage` runs before the warm-up finishes.
- No pricing is applied — the report counts tokens, not money.
- The command reports the lineage of the session it is invoked from. To inspect
  a different family, invoke `/usage` from that session.

## License

MIT — see [LICENSE](LICENSE).
