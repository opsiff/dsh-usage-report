/**
 * `/usage` — token usage for the current session together with every subagent
 * session below it.
 *
 * DSH's `tokenUsage` projection is per-session: a parent log never mentions the
 * tokens its children spent, so the chat UI reports only the main agent and a
 * delegation-heavy turn looks cheaper than it was. This command walks the
 * session lineage and folds every descendant's usage.
 *
 * A family can hold hundreds of children, and replaying one log costs a
 * zstd decompress plus a JSON parse of the whole file, so the command avoids
 * logs entirely on the common path: the running agent answers from its live
 * projections and every finished session answers from its durable projection
 * checkpoint. Those checkpoints already carry the three values a row needs —
 * `tokenUsage`, the `subagent` descriptor label, and `modelSelection`. A log is
 * replayed only for a session that has no usable checkpoint.
 *
 * The reply prints the root, the most expensive children, and one aggregate row
 * for the rest; `/usage all` prints every row.
 *
 * @module dsh-usage-report
 */

/** Plugin name shown in loader diagnostics. */
const name = 'usage-report'

/**
 * Services this command needs: the human-command registry, live session
 * lookup, projection reads, and corpus/lineage reads.
 */
const inject = ['commands', 'sessions', 'sessionProjections', 'sessionQuery']

/** Text shown when the command receives arguments it does not accept. */
const USAGE_HINT = 'Usage: /usage [all] — "all" lists every subagent session instead of the top ones'

/** Subagent rows printed before the rest collapse into one aggregate row. */
const TOP_ROWS = 12

/** Log replays issued at once when no projection answers for a session. */
const REPLAY_CONCURRENCY = 8

/** Longest label shown in the session column before truncation. */
const LABEL_WIDTH = 34

/** Projection keys one table row needs: tokens, the child label, the model. */
const PROJECTION_KEYS = ['tokenUsage', 'subagent', 'modelSelection']

/** An all-zero bucket set; copied so a fold never mutates the constant. */
const EMPTY = Object.freeze({
  uncachedInputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
})

/** @returns {typeof EMPTY} a fresh zero bucket set. */
function zeroBuckets() {
  return { ...EMPTY }
}

/**
 * The provider-reported usage one assistant settlement carries, if any.
 * @param {any} event durable session event.
 * @returns {{inputTokens: number, outputTokens: number, cacheReadTokens?: number, cacheWriteTokens?: number} | undefined}
 */
function usageSample(event) {
  if (event.type === 'assistant/message' && event.data.usage !== undefined) return event.data.usage
  if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return undefined
  const stream = event.data.stream
  if (!Array.isArray(stream)) return undefined
  for (let index = stream.length - 1; index >= 0; index -= 1) {
    const record = stream[index]
    if (record?.type === 'chunk' && record.chunk?.type === 'usage') return record.chunk.usage
  }
  return undefined
}

/**
 * Convert one usage sample into projection buckets.
 * @param {any} sample provider usage.
 * @returns {{uncachedInputTokens: number, outputTokens: number, cacheReadTokens: number, cacheWriteTokens: number}}
 */
function bucketsOf(sample) {
  return {
    uncachedInputTokens: sample.inputTokens ?? 0,
    outputTokens: sample.outputTokens ?? 0,
    cacheReadTokens: sample.cacheReadTokens ?? 0,
    cacheWriteTokens: sample.cacheWriteTokens ?? 0,
  }
}

/**
 * Whether two bucket sets are identical, so a repeated sample adds nothing.
 * @param {any} left first buckets.
 * @param {any} right second buckets.
 * @returns {boolean}
 */
function sameBuckets(left, right) {
  return left.uncachedInputTokens === right.uncachedInputTokens
    && left.outputTokens === right.outputTokens
    && left.cacheReadTokens === right.cacheReadTokens
    && left.cacheWriteTokens === right.cacheWriteTokens
}

/**
 * Fold a complete session log into the `tokenUsage` totals.
 *
 * Mirrors the token-meter unit: each `assistant/message` or `assistant/attempt`
 * contributes the last usage sample in its stream, a retried step replaces its
 * own earlier sample rather than accumulating, and `llm/retry-started` closes
 * the replacement slot. This is the fallback for a session with no checkpoint;
 * on the common path the same numbers arrive as a projection.
 *
 * @param {readonly any[]} events durable events in log order.
 * @returns {{uncachedInputTokens: number, outputTokens: number, cacheReadTokens: number, cacheWriteTokens: number}}
 */
function foldTokens(events) {
  let totals = zeroBuckets()
  let last = null
  for (const event of events) {
    if (event.type === 'llm/retry-started') {
      if (last !== null && last.turn === event.data.turn && last.step === event.data.step) last = null
      continue
    }
    const sample = usageSample(event)
    if (sample === undefined) continue
    const turn = event.data.turn
    const step = event.data.step
    const buckets = bucketsOf(sample)
    const previous = last !== null && last.turn === turn && last.step === step ? last.buckets : undefined
    if (previous !== undefined && sameBuckets(previous, buckets)) continue
    totals = {
      uncachedInputTokens: totals.uncachedInputTokens - (previous?.uncachedInputTokens ?? 0) + buckets.uncachedInputTokens,
      outputTokens: totals.outputTokens - (previous?.outputTokens ?? 0) + buckets.outputTokens,
      cacheReadTokens: totals.cacheReadTokens - (previous?.cacheReadTokens ?? 0) + buckets.cacheReadTokens,
      cacheWriteTokens: totals.cacheWriteTokens - (previous?.cacheWriteTokens ?? 0) + buckets.cacheWriteTokens,
    }
    last = { turn, step, buckets }
  }
  return totals
}

/**
 * Read a child's establishing subagent descriptor and a session's serving model.
 *
 * The fallback source for a session without a checkpoint: the manager appends
 * one `subagent/descriptor` inside a child's initial turn (the first one is
 * authoritative, and root sessions have none), and the newest `request/header`
 * names the model that served the last request.
 *
 * @param {readonly any[]} events durable events in log order.
 * @returns {{label?: string, model?: string}} presentation fields, when present.
 */
function presentationOf(events) {
  let label
  let requested
  let served
  for (const event of events) {
    if (event.type === 'subagent/descriptor' && label === undefined && requested === undefined) {
      if (typeof event.data.label === 'string' && event.data.label.length > 0) label = event.data.label
      if (typeof event.data.agentModel === 'string' && event.data.agentModel.length > 0) requested = event.data.agentModel
      continue
    }
    const model = event.type === 'request/header' ? event.data?.header?.config?.model : undefined
    if (typeof model === 'string' && model.length > 0) served = model
  }
  return { label, model: shortModel(served ?? requested) }
}

/**
 * Drop the provider namespace from a route name.
 * @param {string | undefined} model routed model name.
 * @returns {string | undefined} the display name.
 */
function shortModel(model) {
  return model === undefined ? undefined : model.slice(model.lastIndexOf('/') + 1)
}

/**
 * Sum the four buckets of a projection value.
 * @param {any} usage bucket set, or `undefined` for an unreadable session.
 * @returns {number} total tokens.
 */
function totalOf(usage) {
  return usage === undefined
    ? 0
    : usage.uncachedInputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
}

/**
 * Add one bucket set into another.
 * @param {any} into accumulated buckets.
 * @param {any} usage buckets to add.
 * @returns {any} the accumulated buckets.
 */
function addInto(into, usage) {
  into.uncachedInputTokens += usage.uncachedInputTokens
  into.outputTokens += usage.outputTokens
  into.cacheReadTokens += usage.cacheReadTokens
  into.cacheWriteTokens += usage.cacheWriteTokens
  return into
}

/**
 * Run tasks with a fixed number in flight.
 * @param {readonly any[]} items work items.
 * @param {number} limit maximum concurrent tasks.
 * @param {(item: any) => Promise<void>} task async worker, awaited per item.
 * @returns {Promise<void>} resolves when every task settles.
 */
async function mapLimit(items, limit, task) {
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next
      next += 1
      if (index >= items.length) return
      await task(items[index])
    }
  })
  await Promise.all(workers)
}

/**
 * Read the projection values one row needs, without touching a log.
 *
 * A live session answers from the projections its running agent already folds.
 * A finished session answers from its durable checkpoint, which ends where the
 * session ended, so its values are final. Every key is optional: a checkpoint
 * written before a unit existed simply omits it.
 *
 * @param {any} ctx plugin context with session services.
 * @param {{header: any, live: boolean}} record corpus record for the session.
 * @returns {any} projection values by key, or `undefined` when neither source has the session.
 */
function valuesOf(ctx, record) {
  const sessionId = record.header.id
  if (record.live) {
    const live = ctx.sessions.get(sessionId)
    if (live !== undefined) {
      try {
        const snapshot = ctx.sessionProjections.snapshot(live, PROJECTION_KEYS)
        if (snapshot !== undefined) return snapshot.values
      } catch {
        // A cell can be absent while a turn is mid-flight; the checkpoint below
        // and then the log still answer, so this failure never reaches the user.
      }
    }
  }
  const cache = ctx.get('sessionProjectionCache')
  if (cache !== undefined) {
    try {
      const snapshot = cache.cachedSnapshot(record.header, PROJECTION_KEYS)
      if (snapshot !== undefined) return snapshot.values
    } catch {
      // The cache is a hint, never authority: an unreadable or incompatible
      // checkpoint falls through to the authoritative log.
    }
  }
  return undefined
}

/**
 * Resolve one row's usage and presentation, replaying its log only when no
 * projection answered for the usage.
 *
 * @param {any} ctx plugin context.
 * @param {{header: any, live: boolean}} record corpus record.
 * @param {{usage?: any, label?: string, model?: string}} row row state, filled in place.
 * @returns {Promise<void>}
 */
async function resolveRow(ctx, record, row) {
  if (row.usage !== undefined) return
  try {
    const snapshot = await ctx.sessionQuery.readSession(record.header.id)
    const presentation = presentationOf(snapshot.events)
    row.usage = foldTokens(snapshot.events)
    row.label ??= presentation.label
    row.model ??= presentation.model
  } catch {
    // A log that cannot be replayed leaves the row as a dash rather than hiding
    // the rest of the family.
  }
}

/**
 * Flatten a traced descendant tree into rows carrying their depth.
 * @param {readonly any[]} nodes lineage nodes.
 * @param {number} depth depth of these nodes below the root.
 * @returns {{record: any, depth: number}[]}
 */
function flatten(nodes, depth) {
  const rows = []
  for (const node of nodes) {
    rows.push({ record: node.session, depth })
    rows.push(...flatten(node.descendants, depth + 1))
  }
  return rows
}

/** Format a count with thousands separators. @param {number} value @returns {string} */
function count(value) {
  return value.toLocaleString('en-US')
}

/**
 * Share of prompt-side tokens served from cache, as a percentage string.
 * @param {any} usage bucket set.
 * @returns {string}
 */
function cacheRate(usage) {
  const prompt = usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
  if (prompt === 0) return '—'
  return `${((usage.cacheReadTokens / prompt) * 100).toFixed(1)}%`
}

/** Shorten text to a display budget. @param {string} value @param {number} width @returns {string} */
function clip(value, width) {
  return value.length > width ? `${value.slice(0, width - 1)}…` : value
}

/** Shorten a session id for display. @param {string} id @returns {string} */
function short(id) {
  return id.length > 16 ? `${id.slice(0, 16)}…` : id
}

/**
 * Build the human-readable report.
 *
 * @param {{name: string, model: string, depth: number, usage: any}[]} rows the root followed by its displayed descendants.
 * @param {{count: number, usage: any}} hidden sessions collapsed out of the table.
 * @param {string} rootId id of the lineage root.
 * @param {boolean} showAll whether every descendant is already displayed.
 * @returns {string}
 */
function render(rows, hidden, rootId, showAll) {
  const headers = ['session', 'total', 'input', 'output', 'cache-r', 'cache-w', 'hit', 'model']
  const cells = rows.map((row) => {
    const name = `${'  '.repeat(row.depth)}${clip(row.name, LABEL_WIDTH)}`
    if (row.usage === undefined) return [name, '—', '—', '—', '—', '—', '—', row.model]
    return [
      name,
      count(totalOf(row.usage)),
      count(row.usage.uncachedInputTokens),
      count(row.usage.outputTokens),
      count(row.usage.cacheReadTokens),
      count(row.usage.cacheWriteTokens),
      cacheRate(row.usage),
      row.model,
    ]
  })
  if (hidden.count > 0 && hidden.usage !== undefined) {
    cells.push([
      `  + ${count(hidden.count)} more subagent sessions`,
      count(totalOf(hidden.usage)),
      count(hidden.usage.uncachedInputTokens),
      count(hidden.usage.outputTokens),
      count(hidden.usage.cacheReadTokens),
      count(hidden.usage.cacheWriteTokens),
      cacheRate(hidden.usage),
      '—',
    ])
  }
  const widths = headers.map((header, index) => Math.max(header.length, ...cells.map((row) => row[index].length)))
  const line = (row) => row
    .map((value, index) => (index === 0 || index === headers.length - 1 ? value.padEnd(widths[index]) : value.padStart(widths[index])))
    .join('  ')

  const mainTotal = totalOf(rows[0].usage)
  const childTotal = rows.slice(1).reduce((sum, row) => sum + totalOf(row.usage), 0) + totalOf(hidden.usage)
  const sessions = rows.length + hidden.count
  const unreadable = rows.filter((row) => row.usage === undefined).length

  const lines = [
    `Token usage — session ${short(rootId)}`,
    '',
    line(headers),
    ...cells.map(line),
    '',
    `Main: ${count(mainTotal)}   Subagents: ${count(childTotal)}   Total: ${count(mainTotal + childTotal)} tok   (${count(sessions)} sessions)`,
  ]
  if (!showAll && hidden.count > 0) lines.push(`Showing the ${TOP_ROWS} most expensive subagent sessions; /usage all for the full list.`)
  if (unreadable > 0) lines.push(`${unreadable} session${unreadable === 1 ? '' : 's'} could not be read; the totals omit ${unreadable === 1 ? 'it' : 'them'}.`)
  return lines.join('\n')
}

/**
 * Execute one `/usage` request.
 * @param {any} ctx plugin context.
 * @param {any} invocation command invocation.
 * @returns {Promise<{kind: 'success', text: string} | {kind: 'error', text: string}>}
 */
async function execute(ctx, invocation) {
  const argument = invocation.rawInput.trim()
  if (argument.length > 0 && argument !== 'all') return { kind: 'error', text: USAGE_HINT }
  const showAll = argument === 'all'
  const currentId = invocation.agent.id

  let trace
  try {
    trace = await ctx.sessionQuery.traceSession(currentId, invocation.signal)
    if (trace.ancestors.length > 0) {
      const root = trace.complete ? trace.root : trace.ancestors[trace.ancestors.length - 1]
      trace = await ctx.sessionQuery.traceSession(root.header.id, invocation.signal)
    }
  } catch (error) {
    return { kind: 'error', text: `Token usage unavailable: ${String(error)}` }
  }
  const rootRecord = trace.complete ? trace.root : trace.target
  const lineage = [{ record: rootRecord, depth: 0 }, ...flatten(trace.descendants, 1)]

  // One synchronous pass over projection checkpoints: no log is opened unless a
  // session has no checkpoint at all.
  const rows = lineage.map((entry) => {
    const values = valuesOf(ctx, entry.record)
    return {
      entry,
      usage: values?.tokenUsage,
      label: values?.subagent?.label,
      model: shortModel(values?.modelSelection?.lastUsed?.model),
    }
  })
  await mapLimit(rows.filter((row) => row.usage === undefined), REPLAY_CONCURRENCY, (row) => resolveRow(ctx, row.entry.record, row))

  const nameOf = (row) => {
    const id = row.entry.record.header.id
    return row.label ?? (id === currentId ? `${short(id)} (current)` : short(id))
  }
  const descendants = rows.slice(1)
  const ordered = showAll ? descendants : [...descendants].sort((left, right) => totalOf(right.usage) - totalOf(left.usage)).slice(0, TOP_ROWS)
  const shown = new Set(ordered.map((row) => row.entry.record.header.id))
  const hiddenRows = descendants.filter((row) => !shown.has(row.entry.record.header.id))
  const hiddenUsage = hiddenRows.reduce((sum, row) => addInto(sum, row.usage ?? zeroBuckets()), zeroBuckets())

  const table = [rows[0], ...ordered].map((row) => ({
    name: nameOf(row),
    model: row.model ?? '—',
    depth: row.entry.depth,
    usage: row.usage,
  }))

  return {
    kind: 'success',
    text: render(table, { count: hiddenRows.length, usage: hiddenRows.length > 0 ? hiddenUsage : undefined }, rootRecord.header.id, showAll),
  }
}

/**
 * Register `/usage` for every composed human-command adapter.
 *
 * The first corpus listing in a process reads every stored session header, which
 * on a large history costs seconds and is shared with the Web session list. The
 * command therefore warms that read in the background once, well after boot, so
 * the first `/usage` does not pay for it; `warmAfterMs: 0` disables the warm-up.
 *
 * @param {any} ctx context carrying the command registry and session services.
 * @param {{warmAfterMs?: number}} [config] plugin configuration.
 */
function apply(ctx, config) {
  ctx.effect(function* () {
    yield ctx.commands.register({
      definitionId: 'dsh-usage-report',
      name: 'usage',
      description: 'Show token usage including subagent sessions',
      handler: (invocation) => execute(ctx, invocation),
    })
  }, 'usage-report lifecycle')

  const warmAfterMs = config?.warmAfterMs ?? 20000
  if (warmAfterMs > 0) {
    const timer = setTimeout(() => {
      void ctx.sessionQuery.listSessions().catch(() => {
        // A failed warm-up only means the first command pays for the listing.
      })
    }, warmAfterMs)
    timer.unref()
    ctx.effect(() => () => clearTimeout(timer))
  }
}

export { apply, foldTokens, inject, name }
