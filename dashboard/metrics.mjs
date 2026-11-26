#!/usr/bin/env node
// ccusage-bar metrics: loads the store build.mjs keeps and flattens it into
// one row per prompt (turn), with the derived fields comparisons need.
//
// As a module:
//   import { loadTurns, loadSessions, STORE } from './metrics.mjs'
//   const turns = await loadTurns()          // every turn, oldest first
//
// From a shell:
//   node metrics.mjs                         summary of what's recorded
//   node metrics.mjs --json turns.json       every turn row, as JSON
//   node metrics.mjs --refresh               re-import the logs first
//   (--data <dir> to read another store)
//
// Field meanings and analysis advice: docs/METRICS.md.

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
// where the installed plugin keeps its data (CLAUDE_PLUGIN_DATA for ccusage-bar@ccusage-bar)
export const DEFAULT_DATA = process.env.CLAUDE_PLUGIN_DATA || path.join(CLAUDE_DIR, 'plugins', 'data', 'ccusage-bar-ccusage-bar')
export const STORE = file => path.join(file ?? DEFAULT_DATA, 'metrics.json')

const IN = 0, CW = 1, CR = 2, OUT = 3, CW1H = 4, COST = 5
const BUILTIN_MCP = /^ccd_/ // the desktop app's own tools (task list, wrap-up box)
const SCRATCH = /[\\/]Claude[\\/](Data[\\/][^\\/]+[\\/])?scratch[\\/]?|[\\/]scratch-workspaces[\\/]|[\\/]AppData[\\/](Local|Roaming)[\\/]Claude[\\/]/i

export const family = m => /opus/i.test(m) ? 'Opus' : /sonnet/i.test(m) ? 'Sonnet' : /haiku/i.test(m) ? 'Haiku' : /fable/i.test(m) ? 'Fable' : /mythos/i.test(m) ? 'Mythos' : 'Other'

export function projectOf(cwd) {
  if (!cwd) return { key: '(unknown)', label: 'Unknown folder' }
  if (SCRATCH.test(cwd)) return { key: 'desktop-scratch', label: 'Desktop scratch' }
  return { key: process.platform === 'win32' ? cwd.toLowerCase() : cwd, label: cwd.split(/[\\/]/).filter(Boolean).pop() || cwd }
}

export async function loadStore(dataDir) {
  return JSON.parse(await fs.readFile(STORE(dataDir), 'utf8'))
}

const sumKinds = (byModel, i) => Object.values(byModel ?? {}).reduce((a, u) => a + (u[i] ?? 0), 0)
const day = ms => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }

/**
 * Every recorded turn as a flat row, oldest first. Days that were folded into
 * daily totals (the oldest sessions, past the size cap) are left out: they
 * have no single turns. Options: { dataDir, includeBuiltinMcp: false }.
 */
export async function loadTurns({ dataDir, includeBuiltinMcp = false, store } = {}) {
  store ??= await loadStore(dataDir)
  const rows = []
  for (const s of Object.values(store.sessions)) {
    const project = projectOf(s.cwd)
    const turns = s.turns ?? []
    // the session's cache lifetime: 1 h if it ever wrote 1 h cache, else 5 min
    const ttlMs = turns.some(t => Object.values(t.m ?? {}).some(u => (u[CW1H] ?? 0) > 0)) ? 3_600_000 : 300_000
    const sessionFams = {}
    for (const t of turns) for (const [m, u] of Object.entries(t.m ?? {})) sessionFams[family(m)] = (sessionFams[family(m)] ?? 0) + (u[COST] ?? 0)
    const sessionCost = Object.values(sessionFams).reduce((a, b) => a + b, 0)
    const sessionFamilies = Object.entries(sessionFams).filter(([, c]) => sessionCost > 0 && c / sessionCost >= 0.05).map(([f]) => f)
    const available = [...new Set([...Object.keys(s.addonsPresent ?? {}), ...Object.keys(s.projectAddons ?? {})])]

    let prevEnd = null
    turns.forEach((t, i) => {
      const cost = sumKinds(t.m, COST)
      const costByModel = Object.fromEntries(Object.entries(t.m ?? {}).map(([m, u]) => [m, u[COST] ?? 0]))
      const costByFamily = {}
      for (const [m, c] of Object.entries(costByModel)) costByFamily[family(m)] = (costByFamily[family(m)] ?? 0) + c
      const leadModel = Object.entries(costByModel).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
      const families = Object.entries(costByFamily).filter(([, c]) => cost > 0 && c / cost >= 0.05).map(([f]) => f)
      const subCost = sumKinds(t.sm, COST)
      const mcp = Object.fromEntries(Object.entries(t.mcp ?? {}).filter(([k]) => includeBuiltinMcp || !BUILTIN_MCP.test(k)))
      const idle = prevEnd == null ? null : Math.max(0, t.s - prevEnd)
      rows.push({
        // where and when
        project: project.key, projectLabel: project.label, cwd: s.cwd ?? null,
        session: s.id, sessionTitle: s.title ?? s.prompt ?? null, turnIndex: i,
        start: t.s, end: t.s + (t.d ?? 0), date: day(t.s), hour: new Date(t.s).getHours(),
        claudeCodeVersion: s.ver ?? null, entrypoint: s.ep ?? null,
        // the prompt
        human: (t.o ?? 'h') === 'h', promptChars: t.pc ?? 0, promptSnippet: t.pt ?? null,
        // time
        durationMs: t.d ?? 0, durationExact: !!t.x, aborted: !!t.a,
        idleBeforeMs: idle, cacheLikelyExpired: idle == null ? null : idle > ttlMs,
        // tokens and cost (all models, subagents included)
        cost,
        tokensFreshInput: sumKinds(t.m, IN), tokensCacheWrite: sumKinds(t.m, CW), tokensCacheWrite1h: sumKinds(t.m, CW1H),
        tokensCacheRead: sumKinds(t.m, CR), tokensOutput: sumKinds(t.m, OUT),
        tokensTotal: sumKinds(t.m, IN) + sumKinds(t.m, CW) + sumKinds(t.m, CR) + sumKinds(t.m, OUT),
        contextTokens: t.cx ?? 0,
        // models
        costByModel, costByFamily, leadModel, leadFamily: leadModel ? family(leadModel) : null,
        families, mixedPrompt: families.length >= 2, sessionFamilies, mixedSession: sessionFamilies.length >= 2,
        effort: t.ef ?? null,
        subagentCost: subCost, subagentShare: cost > 0 ? subCost / cost : 0,
        subagentTokens: sumKinds(t.sm, IN) + sumKinds(t.sm, CW) + sumKinds(t.sm, CR) + sumKinds(t.sm, OUT),
        subagentModels: Object.keys(t.sm ?? {}),
        // tools
        toolCalls: t.n ?? 0, tools: t.tl ?? {}, toolErrors: t.er ?? 0,
        mcp, mcpCalls: Object.values(mcp).reduce((a, b) => a + b, 0),
        skills: Object.keys(t.sk ?? {}),
        addonsUsed: Object.keys(t.ad ?? {}),
        addonsInSession: Object.keys(s.addons ?? {}),
        addonsAvailable: available,
        mcpInSession: Object.keys(s.mcp ?? {}).filter(k => includeBuiltinMcp || !BUILTIN_MCP.test(k)),
        mcpConnected: Object.keys(s.mcpConnected ?? {}).filter(k => includeBuiltinMcp || !BUILTIN_MCP.test(k)),
        skillsInSession: Object.keys(s.skills ?? {}),
        // null: not known (the session predates plugin tracking, 0.4.2)
        pluginsEnabled: s.pluginsEnabled ? Object.keys(s.pluginsEnabled) : null,
        compactions: t.cp ?? 0,
      })
      prevEnd = t.s + (t.d ?? 0)
    })
  }
  return rows.sort((a, b) => a.start - b.start)
}

/** One row per session, totals over its turns (folded days included). */
export async function loadSessions({ dataDir, store } = {}) {
  store ??= await loadStore(dataDir)
  return Object.values(store.sessions).map(s => {
    const project = projectOf(s.cwd)
    const units = [...(s.turns ?? []), ...(s.days ?? [])]
    const cost = units.reduce((a, t) => a + sumKinds(t.m, COST), 0)
    return {
      session: s.id, project: project.key, projectLabel: project.label, title: s.title ?? s.prompt ?? null,
      first: s.first, last: s.last, prompts: (s.turns ?? []).length + (s.days ?? []).reduce((a, d) => a + (d.k ?? 0), 0),
      cost, folded: !!s.days?.length, compactions: s.compactions ?? 0,
      addonsUsed: Object.keys(s.addons ?? {}), addonsAvailable: [...new Set([...Object.keys(s.addonsPresent ?? {}), ...Object.keys(s.projectAddons ?? {})])],
      mcp: s.mcp ?? {}, skills: s.skills ?? {}, agents: s.agents ?? {}, tools: s.tools ?? {},
      pluginsEnabled: s.pluginsEnabled ? Object.keys(s.pluginsEnabled) : null,
    }
  })
}

// ---- small statistics helpers for comparisons ----------------------------------

export const median = values => {
  const a = values.filter(v => v != null && Number.isFinite(v)).sort((x, y) => x - y)
  if (!a.length) return null
  const m = a.length >> 1
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2
}
export const mean = values => {
  const a = values.filter(v => v != null && Number.isFinite(v))
  return a.length ? a.reduce((x, y) => x + y, 0) / a.length : null
}

/**
 * Compares rows that have something with rows that don't, the fair way:
 * within each group (by default the project) that has both, then combined
 * (log-ratio of medians, or of means where a median is 0, weighted by the
 * smaller side). Also gives pooled
 * means, which is what a usage limit feels. `metric` maps a row to a number.
 */
export function compare(rows, has, metric, { groupBy = r => r.project, min = 3 } = {}) {
  const groups = new Map()
  for (const r of rows) {
    const k = groupBy(r)
    if (!groups.has(k)) groups.set(k, { with: [], without: [] })
    groups.get(k)[has(r) ? 'with' : 'without'].push(r)
  }
  let sw = 0, swl = 0
  const per = []
  for (const [k, g] of groups) {
    if (g.with.length < min || g.without.length < min) continue
    // medians; for counts that are usually zero (tool calls), means instead
    let a = median(g.with.map(metric)), b = median(g.without.map(metric))
    if (!(a > 0) || !(b > 0)) { a = mean(g.with.map(metric)); b = mean(g.without.map(metric)) }
    if (!(a > 0) || !(b > 0)) continue
    const w = Math.min(g.with.length, g.without.length)
    sw += w; swl += w * Math.log(a / b)
    per.push({ group: k, nWith: g.with.length, nWithout: g.without.length, medianWith: a, medianWithout: b, ratio: a / b })
  }
  const used = per.map(p => groups.get(p.group))
  const w = used.flatMap(g => g.with), wo = used.flatMap(g => g.without)
  return {
    effect: sw > 0 ? Math.exp(swl / sw) - 1 : null, // e.g. -0.2 = 20% lower with it
    groups: per.length, nWith: w.length, nWithout: wo.length,
    medianWith: median(w.map(metric)), medianWithout: median(wo.map(metric)),
    meanWith: mean(w.map(metric)), meanWithout: mean(wo.map(metric)),
    per,
  }
}

// ---- command line --------------------------------------------------------------

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue
    const key = argv[i].slice(2), next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) out[key] = true
    else { out[key] = next; i++ }
  }
  return out
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const dataDir = args.data || DEFAULT_DATA
  if (args.refresh) {
    await new Promise((resolve, reject) => execFile(process.execPath, [path.join(HERE, 'build.mjs'), '--quiet', '--data', dataDir],
      { maxBuffer: 64 * 1024 * 1024 }, err => (err ? reject(err) : resolve())))
  }
  const store = await loadStore(dataDir)
  const turns = await loadTurns({ store })
  if (args.json) {
    await fs.writeFile(args.json, JSON.stringify(turns))
    console.log(`${turns.length} turns written to ${args.json}`)
    return
  }
  const sessions = new Set(turns.map(t => t.session)), projects = new Set(turns.map(t => t.project))
  const exact = turns.filter(t => t.durationExact).length
  console.log(`store: ${STORE(dataDir)} (built ${new Date(store.builtAt).toLocaleString()})`)
  console.log(`${turns.length} turns, ${sessions.size} sessions, ${projects.size} projects, ${turns.length ? `${turns[0].date} to ${turns.at(-1).date}` : 'no dates'}`)
  console.log(`${exact} turns timed exactly by the mod; the rest estimated from the logs`)
  const folded = Object.values(store.sessions).filter(s => s.days?.length).length
  if (folded) console.log(`${folded} sessions folded into daily totals (not in turn rows)`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(err => { console.error(err?.stack || err); process.exit(1) })
}
