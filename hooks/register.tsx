import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { LastTurn, ModelShare, TurnStats, UsageSnapshot } from '../types'

const snapshot = atom({ plugin: 'ccusage-bar', key: 'snapshot' } as const, null)
const isHidden = atom({ plugin: 'ccusage-bar', key: 'isHidden' } as const, false)
const scope = atom({ plugin: 'ccusage-bar', key: 'scope' } as const, 'session' as 'session' | 'project' | 'turn')
const lastTurn = atom({ plugin: 'ccusage-bar', key: 'lastTurn' } as const, null as LastTurn | null)
const showCosts = atom({ plugin: 'ccusage-bar', key: 'costsOpen' } as const, true)
// Turn timing for this session. $.state keeps it across mod reloads only;
// $.store (below) keeps it across restarts, so a resumed session gets it back.
const turnStats = atom(
  { plugin: 'ccusage-bar', key: 'turnStats' } as const,
  { count: 0, totalMs: 0 } as TurnStats,
)

const REFRESH_MS = 60_000

// $.store is shared by every session, so the totals sit in one map keyed by
// session id; past STATS_KEEP sessions the least recently used are dropped.
const STATS_KEY = 'turnStats'
const STATS_KEEP = 50
type SavedStats = Record<string, TurnStats & { at: number }>

async function loadSavedStats($: any): Promise<SavedStats> {
  const v = await $.store.get(STATS_KEY)
  return v && typeof v === 'object' ? (v as SavedStats) : {}
}

async function saveStats($: any, stats: TurnStats) {
  const id = await $.session.id()
  const all = await loadSavedStats($)
  all[id] = { count: stats.count, totalMs: stats.totalMs, at: Date.now() }
  const kept = Object.entries(all).sort((a, b) => b[1].at - a[1].at).slice(0, STATS_KEEP)
  await $.store.set(STATS_KEY, Object.fromEntries(kept))
}

// At start: take the saved totals when they hold more turns than $.state does
// (a fresh process starts at zero; a hot reload already has them).
async function restoreStats($: any) {
  const saved = (await loadSavedStats($))[await $.session.id()]
  if (!saved || !(saved.count > 0)) return
  await update($, turnStats, prev =>
    (prev?.count ?? 0) >= saved.count ? prev : { count: saved.count, totalMs: saved.totalMs },
  )
}

// Status colors that read on both light and dark backgrounds.
const GREEN = '#2fa36b'
const YELLOW = '#d9a000'
const ORANGE = '#e8742a'
const RED = '#e5484d'
const TRACK = 'rgba(128,128,128,0.28)'
// view button prices: Tally's orange, so they stand out from the names
// (the button's own dimming still marks which view is not selected)
const PRICE_COLOR = '#d97757'

const tone = (pct: number) =>
  pct < 50 ? GREEN : pct < 70 ? YELLOW : pct < 85 ? ORANGE : RED

const EMPTY: Omit<UsageSnapshot, 'error'> = {
  sessionCost: null, sessionTokens: null,
  folderCost: null, folderTokens: null, folderSessions: null,
  todayCost: null, sessionCacheHit: null, folderCacheHit: null,
  sessionModels: [], folderModels: [], fetchedAt: 0,
}

// Higher is better for the cache, so its colors run the other way.
const cacheTone = (pct: number) =>
  pct >= 80 ? GREEN : pct >= 60 ? YELLOW : pct >= 40 ? ORANGE : RED

// cache reads ÷ every input token (fresh input + cache writes + cache reads)
const cacheHit = (r: any): number | null => {
  if (!r) return null
  const read = r.cacheReadTokens ?? 0
  const all = (r.inputTokens ?? 0) + (r.cacheCreationTokens ?? 0) + read
  return all > 0 ? (read / all) * 100 : null
}

const addModels = (into: Map<string, number>, breakdowns: any[] | undefined) => {
  for (const b of breakdowns ?? []) {
    if (!b?.modelName || b.modelName === '<synthetic>') continue
    into.set(b.modelName, (into.get(b.modelName) ?? 0) + (b.cost ?? 0))
  }
  return into
}

const sortModels = (m: Map<string, number>): ModelShare[] =>
  [...m.entries()].map(([name, cost]) => ({ name, cost })).sort((a, b) => b.cost - a.cost)

const family = (name: string) =>
  /opus/i.test(name) ? 'Opus' : /sonnet/i.test(name) ? 'Sonnet' : /haiku/i.test(name) ? 'Haiku' : /fable/i.test(name) ? 'Fable' : 'Other'

const FAMILY_COLOR: Record<string, string> = {
  Opus: '#d97757', Sonnet: '#7c6cf0', Haiku: '#2fa36b', Fable: '#d9a000', Other: '#8a8a8a',
}

// Model costs grouped by family, as percents, largest first.
const mix = (models: ModelShare[]) => {
  const byFamily = new Map<string, number>()
  for (const m of models) byFamily.set(family(m.name), (byFamily.get(family(m.name)) ?? 0) + m.cost)
  const total = [...byFamily.values()].reduce((a, b) => a + b, 0)
  if (total <= 0) return []
  return [...byFamily.entries()]
    .map(([name, cost]) => ({ name, pct: (cost / total) * 100 }))
    .filter(p => p.pct >= 0.5) // a sliver like "Haiku 0%" is noise
    .sort((a, b) => b.pct - a.pct)
}

// A thin stacked bar, one segment per model family.
const mixBar = (parts: { name: string; pct: number }[]) => {
  const w = 40
  let x = 0
  const segs = parts.map(p => {
    const width = (p.pct / 100) * w
    const seg = `<rect x="${x.toFixed(2)}" y="0" width="${width.toFixed(2)}" height="6" fill="${FAMILY_COLOR[p.name] ?? '#8a8a8a'}"/>`
    x += width
    return seg
  })
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="6" viewBox="0 0 ${w} 6">
<clipPath id="r"><rect width="${w}" height="6" rx="3"/></clipPath>
<g clip-path="url(#r)"><rect width="${w}" height="6" fill="${TRACK}"/>${segs.join('')}</g>
</svg>`
}

const money = (n: number | null | undefined) =>
  n === null || n === undefined ? '—' : n >= 100 ? `$${Math.round(n)}` : `$${n.toFixed(2)}`

const tokens = (n: number | null | undefined) => {
  if (n === null || n === undefined) return '—'
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`
  return String(Math.round(n))
}

// How long something took: 12s, 1m 12s, 1h 3m.
const elapsed = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

// Time left: 48m, 1h 0m, <1m.
const countdown = (ms: number) => {
  const m = Math.floor(ms / 60_000)
  if (m < 1) return '<1m'
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`
}

const today = () => {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
}

// Claude Code stores a folder's logs under its path with every
// non-alphanumeric character turned into "-": C:\a b -> C--a-b.
const projectKey = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/g, '-')

const folderName = (cwd: string) => cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd

// ---- small SVG pieces (desktop) -------------------------------------------

const ring = (pct: number, color: string) => {
  const r = 6.25
  const c = 2 * Math.PI * r
  const on = Math.max(0, Math.min(1, pct / 100)) * c
  return `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">
<circle cx="8" cy="8" r="${r}" fill="none" stroke="${TRACK}" stroke-width="2.5"/>
<circle cx="8" cy="8" r="${r}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linecap="round"
 stroke-dasharray="${on.toFixed(2)} ${c.toFixed(2)}" transform="rotate(-90 8 8)"/>
</svg>`
}

const badge = (letter: string, color: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 18 18">
<rect width="18" height="18" rx="4" fill="${color}"/>
<text x="9" y="13" text-anchor="middle" font-family="system-ui,-apple-system,Segoe UI,sans-serif"
 font-size="11" font-weight="700" fill="#fff">${letter}</text>
</svg>`

const check = (color: string, isOk: boolean) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none"
 stroke="${color}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
<circle cx="8" cy="8" r="6.5"/>${isOk ? '<path d="M5.2 8.2l1.9 1.9 3.7-3.9"/>' : '<path d="M8 4.8v3.8"/><path d="M8 11.1v.1"/>'}
</svg>`

// ---- the mascot: "Tally", an original little meter creature ----------------
//
// A rounded body with a three-bar gauge on its belly, two eyes
// and stubby feet, animated with SMIL (runs in the desktop's SVG image):
//   calm     bobs gently and blinks every few seconds
//   worried  (context 70%+) orange, flat mouth, quicker bob
//   alarmed  (context 85%+) red, open mouth, shivers
//   working  (Claude is mid-turn) eyes scan, gauge bars bounce,
//            feet shuffle
type Mood = 'calm' | 'worried' | 'alarmed'

const MOOD_COLOR: Record<Mood, string> = { calm: '#d97757', worried: ORANGE, alarmed: RED }

function mascot(mood: Mood, isWorking: boolean) {
  const body = MOOD_COLOR[mood]
  const dark = '#2b2320'

  // whole-body motion
  const motion =
    mood === 'alarmed'
      ? `<animateTransform attributeName="transform" type="translate" dur="0.9s" repeatCount="indefinite"
          values="0 0;-0.7 0;0.7 0;-0.7 0;0 0;0 0" keyTimes="0;0.1;0.2;0.3;0.4;1"/>`
      : `<animateTransform attributeName="transform" type="translate" repeatCount="indefinite"
          dur="${mood === 'worried' || isWorking ? '1.2s' : '2.6s'}" values="0 0;0 -1.4;0 0"
          keyTimes="0;0.5;1" calcMode="spline" keySplines=".45 0 .55 1;.45 0 .55 1"/>`

  // eyes: whites blink; pupils scan while working
  const blink = `<animate attributeName="ry" dur="4.2s" repeatCount="indefinite"
      values="2.7;2.7;0.25;2.7" keyTimes="0;0.93;0.96;1"/>`
  const pupilBlink = `<animate attributeName="r" dur="4.2s" repeatCount="indefinite"
      values="1.25;1.25;0;1.25" keyTimes="0;0.93;0.96;1"/>`
  const scan = isWorking
    ? `<animateTransform attributeName="transform" type="translate" dur="1.6s" repeatCount="indefinite"
        values="-0.9 0;0.9 0;-0.9 0"/>`
    : ''
  const eye = (cx: number) => `
    <ellipse cx="${cx}" cy="13.5" rx="2.4" ry="2.7" fill="#fff">${blink}</ellipse>
    <g>${scan}<circle cx="${cx + 0.3}" cy="13.9" r="1.25" fill="${dark}">${pupilBlink}</circle></g>`

  const brows =
    mood === 'calm'
      ? ''
      : `<path d="M10.3 9.6 L14.3 ${mood === 'alarmed' ? 10.9 : 10.3}" stroke="${dark}" stroke-width="1" stroke-linecap="round"/>
         <path d="M23.7 9.6 L19.7 ${mood === 'alarmed' ? 10.9 : 10.3}" stroke="${dark}" stroke-width="1" stroke-linecap="round"/>`

  const mouth =
    mood === 'calm'
      ? `<path d="M15 18.2 q2 1.6 4 0" stroke="${dark}" stroke-width="1.1" fill="none" stroke-linecap="round"/>`
      : mood === 'worried'
        ? `<path d="M15.2 18.9 h3.6" stroke="${dark}" stroke-width="1.1" stroke-linecap="round"/>`
        : `<ellipse cx="17" cy="19" rx="1.3" ry="1.5" fill="${dark}"/>`

  // the belly gauge: three bars; they bounce while working
  const bar = (x: number, h: number, i: number) => {
    const y = 26 - h
    const bounce = isWorking
      ? `<animate attributeName="height" dur="0.9s" begin="${i * 0.15}s" repeatCount="indefinite"
          values="${h};${h + 1.6};${h}"/>
         <animate attributeName="y" dur="0.9s" begin="${i * 0.15}s" repeatCount="indefinite"
          values="${y};${y - 1.6};${y}"/>`
      : ''
    return `<rect x="${x}" y="${y}" width="2" height="${h}" rx="0.6" fill="#fff" opacity="${0.65 + i * 0.15}">${bounce}</rect>`
  }

  const shuffle = (begin: string) =>
    isWorking
      ? `<animateTransform attributeName="transform" type="translate" dur="0.5s" begin="${begin}"
          repeatCount="indefinite" values="0 0;0 -0.8;0 0"/>`
      : ''

  return `<svg xmlns="http://www.w3.org/2000/svg" width="34" height="34" viewBox="0 0 34 34">
<g>${motion}
  <rect x="7" y="29" width="5" height="2.6" rx="1.2" fill="${dark}">${shuffle('0s')}</rect>
  <rect x="22" y="29" width="5" height="2.6" rx="1.2" fill="${dark}">${shuffle('0.25s')}</rect>
  <rect x="4" y="5.5" width="26" height="24.5" rx="8" fill="${body}"/>
  <rect x="4" y="5.5" width="26" height="24.5" rx="8" fill="#fff" opacity="0.08"/>
  ${eye(13)}${eye(21)}
  ${brows}
  ${mouth}
  ${bar(13.5, 2.5, 0)}${bar(16, 4, 1)}${bar(18.5, 5.5, 2)}
</g>
</svg>`
}

// ---- data -----------------------------------------------------------------

let isWindows = false
let isRefreshing = false
let turnStartCost: number | null = null
let turnTools = 0
// this turn's MCP servers and skills, by number of calls
let turnMcp: Record<string, number> = {}
let turnSkills: Record<string, number> = {}

// ---- the dashboard's turn records --------------------------------------------
//
// One file per session under the plugin's data folder, read by
// dashboard/build.mjs, which merges them with Claude Code's own logs.

let dataDir: string | null = null
let isBuilding = false

async function saveTurn($: any, turn: LastTurn, u: any, mcp: Record<string, number>, skills: Record<string, number>) {
  if (!dataDir) return
  const id = await $.session.id()
  const file = `${dataDir}/turns/${id}.json`
  let rec: any = null
  try { rec = JSON.parse(await $.fs.read(file)) } catch { /* the session's first turn */ }
  if (!rec || !Array.isArray(rec.turns)) rec = { sessionId: id, cwd: await $.session.cwd(), turns: [] }
  // MCP servers this session can reach, used or not (for the dashboard's legend)
  try {
    const servers = (await $.tool.list())
      .filter((t: any) => t.mcp)
      .map((t: any) => String(t.name).split('__')[1] ?? '')
      .filter(Boolean)
    rec.mcpConnected = [...new Set([...(rec.mcpConnected ?? []), ...servers])]
  } catch { /* keep what we had */ }
  const model = u?.model
  rec.turns.push({
    e: turn.endedAt,
    d: turn.durationMs,
    ...(turn.isAborted ? { a: 1 } : {}),
    m: model
      ? {
          [model]: [
            u.input_tokens ?? 0,
            u.cache_creation_input_tokens ?? 0,
            u.cache_read_input_tokens ?? 0,
            u.output_tokens ?? 0,
            u.ephemeral_1h_input_tokens ?? 0,
          ],
        }
      : {},
    c: turn.cost,
    n: turn.tools,
    ...(Object.keys(mcp).length ? { mcp } : {}),
    ...(Object.keys(skills).length ? { sk: skills } : {}),
  })
  await $.fs.write(file, JSON.stringify(rec))
}

// Runs dashboard/build.mjs with Node: imports the logs into the store and
// writes the pages.
async function runBuilder($: any, extra: string[]) {
  let env: Record<string, string> = {}
  try {
    env = await $.process.hookEnv()
  } catch {
    /* the builder falls back to ~/.claude/ccusage-bar */
  }
  const argv = ['node', `${$.plugin.root}/dashboard/build.mjs`, '--quiet', ...extra]
  if (dataDir) argv.push('--data', dataDir)
  return $.process.run(argv, { env, timeoutMs: 600_000 })
}

// Once a day, in the background: import the logs into the store, so the
// history is kept even if nobody opens the dashboard before Claude Code
// deletes old logs (after 30 days by default).
const IMPORT_EVERY_MS = 20 * 60 * 60_000

async function importDaily($: any) {
  const last = Number((await $.store.get('lastImport')) ?? 0)
  if (Date.now() - last < IMPORT_EVERY_MS || isBuilding) return
  await $.store.set('lastImport', Date.now()) // claimed first, so two windows don't both run it
  isBuilding = true
  try {
    const ran = await runBuilder($, [])
    if (ran.exitCode !== 0) await $.store.set('lastImport', last)
  } finally {
    isBuilding = false
  }
}

// Builds the dashboard page with Node and opens it in the browser.
async function openDashboard($: any): Promise<string> {
  if (isBuilding) return 'The dashboard is already being built.'
  isBuilding = true
  try {
    const ran = await runBuilder($, ['--open'])
    if (ran.exitCode !== 0) {
      const why = String(ran.stderr || ran.stdout).trim().split('\n').pop() ?? ''
      return `Dashboard failed: ${why.slice(0, 160)}`
    }
    return 'Dashboard opened in your browser.'
  } catch (err) {
    return `Dashboard failed: ${err instanceof Error ? err.message : String(err)} (is Node.js installed?)`
  } finally {
    isBuilding = false
  }
}

async function pressDashboard($: any) {
  $.ui.toast('Building the dashboard…')
  $.ui.toast(await openDashboard($))
}

// ccusage is a Node CLI; on Windows its npm shim is a .cmd, which only cmd.exe runs.
async function ccusage($: any, args: string[]) {
  const argv = isWindows
    ? ['cmd.exe', '/d', '/s', '/c', 'ccusage', ...args]
    : ['ccusage', ...args]
  const ran = await $.process.run(argv, { timeoutMs: 20_000 })
  if (ran.exitCode !== 0) {
    const line = String(ran.stderr || ran.stdout).trim().split('\n')[0]
    throw new Error(line || `ccusage exited ${ran.exitCode}`)
  }
  return JSON.parse(ran.stdout)
}

async function refresh($: any) {
  if (isRefreshing) return
  isRefreshing = true
  try {
    const [id, cwd] = await Promise.all([$.session.id(), $.session.cwd()])
    const [daily, folder] = await Promise.all([
      ccusage($, ['daily', '--json', '--offline', '--since', today()]),
      ccusage($, ['session', '--json', '--offline', '--project', projectKey(cwd)]),
    ])
    const day = (daily.daily ?? [])[0] ?? null
    const sessions: any[] = folder.session ?? []
    const mine = sessions.find(s => s.period === id || s.sessionId === id) ?? null

    const next: UsageSnapshot = {
      sessionCost: mine?.totalCost ?? 0,
      sessionTokens: mine?.totalTokens ?? 0,
      folderCost: folder.totals?.totalCost ?? 0,
      folderTokens: folder.totals?.totalTokens ?? 0,
      folderSessions: sessions.length,
      todayCost: day?.totalCost ?? 0,
      sessionCacheHit: cacheHit(mine),
      folderCacheHit: cacheHit(folder.totals),
      sessionModels: sortModels(addModels(new Map(), mine?.modelBreakdowns)),
      sessionLastActivity: mine?.metadata?.lastActivity ? Date.parse(mine.metadata.lastActivity) : null,
      sessionCache1h: mine
        ? (mine.modelBreakdowns ?? []).some((b: any) => (b.cacheCreation1hTokens ?? 0) > 0)
        : null,
      folderModels: sortModels(
        sessions.reduce((m, s) => addModels(m, s.modelBreakdowns), new Map<string, number>()),
      ),
      fetchedAt: Date.now(),
      error: null,
    }
    await update($, snapshot, () => next)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await update($, snapshot, prev => ({ ...(prev ?? EMPTY), error: message.slice(0, 120) }))
  } finally {
    isRefreshing = false
  }
}

// ---- hooks ----------------------------------------------------------------

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // before the first prompt, so a turn can't finish ahead of the restore
    await restoreStats($).catch(() => {})
    try {
      dataDir = (await $.process.hookEnv()).CLAUDE_PLUGIN_DATA ?? null
    } catch {
      dataDir = null // no data folder: the bar works, the dashboard gets only the logs
    }
    isWindows = (await $.session.machine()).sysname === 'Windows_NT'
    $.command.register({
      name: 'ccusage-bar',
      description: 'ccusage bar: show | hide | refresh | dashboard',
    })
    void refresh($)
    $.clock.every(REFRESH_MS, () => void refresh($))
    void importDaily($).catch(() => {}) // never holds up the session
    return next(e)
  })

  // Last turn: Claude Code's running session cost when the prompt goes in,
  // subtracted from it when the turn ends, plus the turn's own token counts.
  on('prompt.submit', async ($, e, next) => {
    turnStartCost = (await $.session.usage()).cost?.usd ?? null
    turnTools = 0
    turnMcp = {}
    turnSkills = {}
    return next(e)
  }).catch(($, e, next) => next(e)) // never hold up a prompt over a metric

  on('tool.call', ($, e, next) => {
    turnTools += 1
    const name = String(e.tool)
    if (name.startsWith('mcp__')) {
      const server = name.split('__')[1] || 'mcp'
      turnMcp[server] = (turnMcp[server] ?? 0) + 1
    } else if (name === 'Skill') {
      const skill = String((e as any).skill ?? '').replace(/^\//, '')
      if (skill) turnSkills[skill] = (turnSkills[skill] ?? 0) + 1
    }
    return next(e)
  }).catch(($, e, next) => next(e)) // nor a tool call

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result // a subagent's turn, not yours

    const end = (await $.session.usage()).cost?.usd
    const u = e.usage
    const read = u?.cache_read_input_tokens ?? 0
    const allIn = (u?.input_tokens ?? 0) + (u?.cache_creation_input_tokens ?? 0) + read
    const ttl =
      (u?.ephemeral_1h_input_tokens ?? 0) > 0
        ? 60 * 60_000
        : (u?.ephemeral_5m_input_tokens ?? 0) > 0 || (u?.cache_creation_input_tokens ?? 0) > 0
          ? 5 * 60_000
          : null

    const turn: LastTurn = {
      cost: turnStartCost !== null && end !== undefined ? Math.max(0, end - turnStartCost) : null,
      durationMs: e.durationMs,
      tools: turnTools,
      inputTokens: allIn,
      outputTokens: u?.output_tokens ?? 0,
      cacheHit: allIn > 0 ? (read / allIn) * 100 : null,
      model: u?.model ?? null,
      endedAt: Date.now(),
      cacheTtlMs: ttl,
      isAborted: e.isAborted,
    }
    await update($, lastTurn, () => turn)
    // for the dashboard; never fails the turn
    void saveTurn($, turn, u, turnMcp, turnSkills).catch(() => {})
    // A stopped turn was cut short, so it would drag the average down.
    if (!e.isAborted) {
      let stats: TurnStats | null = null
      await update($, turnStats, prev => (stats = {
        count: (prev?.count ?? 0) + 1,
        totalMs: (prev?.totalMs ?? 0) + e.durationMs,
      }))
      if (stats) await saveStats($, stats).catch(() => {}) // a metric never fails the turn
    }
    void refresh($)
    return result
  })

  on('command.run', { command: 'ccusage-bar' }, async ($, e, next) => {
    const arg = String(e.args ?? '').trim().toLowerCase()
    if (arg === 'dashboard') return { text: await openDashboard($) }
    if (arg === 'hide') {
      await update($, isHidden, () => true)
      return { text: 'ccusage bar hidden. Run /ccusage-bar show to bring it back.' }
    }
    await update($, isHidden, () => false)
    await refresh($)
    const s = await read($, snapshot)
    return { text: s?.error ? `ccusage failed: ${s.error}` : 'ccusage bar refreshed.' }
  }).catch(() => ({ text: 'ccusage bar: the command failed.' }))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const s = await read($, snapshot)
    if (e.props.hasSurvey || s === null || (await read($, isHidden))) {
      return next(e)
    }

    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const Svg = 'Svg' in ui ? ui.Svg : null
    const view = await read($, scope)
    const isCostsOpen = await read($, showCosts)
    const isProject = view === 'project'
    const isTurn = view === 'turn'
    const usage = await $.session.usage()
    const cwd = await $.session.cwd()
    const now = Date.now()

    // ---- figures
    const ctxPct = Math.round(usage.context.percent ?? 0)
    const sessionCost = s.sessionCost ?? usage.cost?.usd ?? null
    const turn = await read($, lastTurn)
    const stats = await read($, turnStats)
    const avgTurnMs = stats && stats.count > 0 ? stats.totalMs / stats.count : null
    const turnCostText = turn?.cost == null ? '—' : `+${money(turn.cost)}`

    // Cache countdown: the cache lives `ttl` after the last request that used it.
    const lastAt = Math.max(turn?.endedAt ?? 0, s.sessionLastActivity ?? 0)
    const ttl =
      turn?.cacheTtlMs ??
      (s.sessionCache1h === true ? 60 * 60_000 : s.sessionCache1h === false ? 5 * 60_000 : null)
    const cacheLeft = lastAt > 0 && ttl !== null ? lastAt + ttl - now : null
    const cacheLeftPct = cacheLeft !== null && ttl ? Math.max(0, (cacheLeft / ttl) * 100) : 0
    const cacheLeftColor =
      cacheLeft === null || cacheLeft <= 0
        ? TRACK
        : cacheLeftPct >= 25 ? GREEN : cacheLeftPct >= 10 ? ORANGE : RED
    const cacheLeftText =
      cacheLeft === null ? '—' : cacheLeft <= 0 ? 'expired' : countdown(cacheLeft)

    // A snapshot saved by an older version of the mod may lack these fields.
    const hit = isTurn
      ? turn?.cacheHit ?? null
      : (isProject ? s.folderCacheHit : s.sessionCacheHit) ?? null
    const parts = isTurn
      ? turn?.model ? [{ name: family(turn.model), pct: 100 }] : []
      : mix((isProject ? s.folderModels : s.sessionModels) ?? [])
    const mixText = parts.length
      ? isTurn
        ? parts[0]!.name
        : parts.slice(0, 3).map(p => `${p.name} ${Math.round(p.pct)}%`).join(' · ')
      : '—'

    const sessionPct = s.folderCost ? ((sessionCost ?? 0) / s.folderCost) * 100 : 0
    const turnPct = turn?.cost != null && sessionCost ? (turn.cost / sessionCost) * 100 : 0

    // ---- headline: context fill decides it
    const headline =
      s.error && s.fetchedAt === 0
        ? { text: 'ccusage unavailable.', color: RED, ok: false }
        : ctxPct >= 85
          ? { text: 'Near a limit.', color: RED, ok: false }
          : ctxPct >= 70
            ? { text: 'Heads up.', color: ORANGE, ok: false }
            : { text: 'All clear.', color: GREEN, ok: true }

    const VIEWS = [
      { id: 'session', label: 'Session' },
      { id: 'project', label: 'Project' },
      { id: 'turn', label: 'Last turn' },
    ] as const

    const viewPrice: Record<(typeof VIEWS)[number]['id'], string> = {
      session: money(sessionCost),
      project: money(s.folderCost),
      turn: money(turn?.cost),
    }

    // ---- terminal: compact text, no SVG there
    if (Svg === null) {
      const nextView = VIEWS[(VIEWS.findIndex(v => v.id === view) + 1) % VIEWS.length]!.id
      return (
        <Box flexDirection="row" gap={2} flexWrap="wrap">
          <Text bold>ccusage</Text>
          <Text color={headline.color}>{headline.ok ? '✓' : '!'} {headline.text}</Text>
          <Button
            key="scope"
            plain
            label={`[${VIEWS.find(v => v.id === view)?.label ?? 'Session'}]`}
            onPress={() => update($, scope, () => nextView)}
          />
          <Button key="dashboard" plain label="[dashboard]" onPress={() => pressDashboard($)} />
          {isTurn ? (
            turn === null ? (
              <Text dimColor>last turn fills in after your next message</Text>
            ) : (
              <Text>
                <Text bold>{turnCostText}</Text>{' '}
                <Text dimColor>
                  {elapsed(turn.durationMs)} · {turn.tools} tools · {tokens(turn.inputTokens)} in ·{' '}
                  {tokens(turn.outputTokens)} out{hit !== null ? ` · ${Math.round(hit)}% cached` : ''}
                </Text>
              </Text>
            )
          ) : (
            <>
              <Text>
                <Text bold>{money(isProject ? s.folderCost : sessionCost)}</Text>{' '}
                <Text dimColor>{isProject ? folderName(cwd) : 'session'}</Text>
              </Text>
              <Text><Text bold>{turnCostText}</Text> <Text dimColor>last turn</Text></Text>
              <Text>
                <Text bold>{tokens(isProject ? s.folderTokens : s.sessionTokens)}</Text>{' '}
                <Text dimColor>tokens</Text>
              </Text>
              {hit !== null ? (
                <Text><Text bold color={cacheTone(hit)}>{Math.round(hit)}%</Text> <Text dimColor>cache hit</Text></Text>
              ) : null}
            </>
          )}
          <Text><Text bold>{cacheLeftText}</Text> <Text dimColor>cache</Text></Text>
          <Text><Text bold color={tone(ctxPct)}>{ctxPct}%</Text> <Text dimColor>context</Text></Text>
        </Box>
      )
    }

    const Metric = (p: { k: string; icon: string; alt: string; value: string; label: string; big?: boolean }) => (
      <Box key={p.k} flexDirection="row" alignItems="center" gap={1}>
        <Svg source={p.icon} alt={p.alt} width={p.big ? 18 : 14} height={p.big ? 18 : 14} />
        <Text size={p.big ? "heading" : "body"} weight="bold" tabular>{p.value}</Text>
        <Text size="body" dimColor>{p.label}</Text>
      </Box>
    )

    const Stat = (p: { k: string; value: string; label: string; big?: boolean }) => (
      <Box key={p.k} flexDirection="row" alignItems="center" gap={1}>
        <Text size={p.big ? "heading" : "body"} weight="bold" tabular>{p.value}</Text>
        <Text size="body" dimColor>{p.label}</Text>
      </Box>
    )


    const shared = [
      Metric({
        k: 'cache-left',
        icon: ring(cacheLeftPct, cacheLeftColor),
        alt: 'time until the prompt cache expires',
        value: cacheLeftText,
        label: 'cache',
        big: true,
      }),
      Metric({
        k: 'context',
        icon: ring(ctxPct, tone(ctxPct)),
        alt: 'context used',
        value: `${ctxPct}%`,
        label: 'context',
        big: true,
      }),
    ]

    const cacheHitMetric = Metric({
      k: 'cache-hit',
      icon: ring(hit ?? 0, cacheTone(hit ?? 0)),
      alt: 'prompt cache hit rate',
      value: hit === null ? '—' : `${Math.round(hit)}%`,
      label: isTurn ? 'cached' : 'cache hit',
      big: true,
    })

    return (
      <Box flexDirection="row" alignItems="center" gap={1}>
        <Svg
          source={mascot(
            ctxPct >= 85 ? 'alarmed' : ctxPct >= 70 || (s.error && s.fetchedAt === 0) ? 'worried' : 'calm',
            e.props.isWorking,
          )}
          alt={e.props.isWorking ? 'Tally is counting' : `Tally: ${headline.text}`}
          width={34}
          height={34}
        />
        <Box flexDirection="column" gap={0} flexGrow={1}>
          <Box key="head" flexDirection="row" alignItems="center" gap={1}>
            <Text size="body" weight="semibold">ccusage</Text>
            <Svg source={check(headline.color, headline.ok)} alt={headline.text} width={14} height={14} />
            <Text size="body" dimColor>{headline.text}</Text>
            {/* Tally itself can't take a click in this build, so the way in sits beside it */}
            <Text size="body" dimColor>·</Text>
            <Button key="dashboard" plain dimColor label="📊 Dashboard" onPress={() => pressDashboard($)} />
            <Box flexGrow={1} />
            {/* each view's price sits beside its button */}
            {VIEWS.flatMap((v, i) => [
              i > 0 ? <Text key={`dot-${v.id}`} size="body" dimColor>·</Text> : null,
              <Box key={`view-${v.id}`} flexDirection="row" alignItems="center" gap={1}>
                <Button
                  key={`view-${v.id}-name`}
                  plain
                  dimColor={view !== v.id}
                  label={v.label}
                  onPress={() => update($, scope, () => v.id)}
                />
                {/* outside the button: the app drops text colour inside one */}
                <Text size="body" weight="bold" tabular color={PRICE_COLOR} dimColor={view !== v.id}>
                  {viewPrice[v.id]}
                </Text>
              </Box>,
            ])}
            <Button key="refresh" plain dimColor label="↻" onPress={() => refresh($)} />
            {isTurn ? null : (
            <Button
              key="costs-toggle"
              plain
              dimColor
              label={isCostsOpen ? '▴' : '▾'}
              onPress={() => update($, showCosts, v => !v)}
            />
            )}
          </Box>

          <Box key="tokens-row" flexDirection="row" alignItems="center" gap={3} flexWrap="wrap">
            {isTurn
              ? turn === null
                ? [<Text key="t-none" size="body" dimColor>Last turn fills in after your next message</Text>]
                : [
                    <Box key="t-time" flexDirection="row" alignItems="center" gap={1}>
                      <Text size="heading" weight="bold" tabular>{elapsed(turn.durationMs)}</Text>
                      {turn.isAborted ? <Text size="body" color={ORANGE}>stopped</Text> : null}
                    </Box>,
                    Stat({ k: 't-tools', value: String(turn.tools), label: turn.tools === 1 ? 'tool' : 'tools', big: true }),
                    Stat({ k: 't-in', value: tokens(turn.inputTokens), label: 'in', big: true }),
                    Stat({ k: 't-out', value: tokens(turn.outputTokens), label: 'out', big: true }),
                    cacheHitMetric,
                  ]
              : [
                  Stat({ k: 'tokens', value: tokens(isProject ? s.folderTokens : s.sessionTokens), label: 'tokens', big: true }),
                  cacheHitMetric,
                ]}
            {shared}
            {/* last in the row in Session view; Last turn has it in its bottom row,
                and Project leaves it out (it is this session's figure) */}
            {isProject || isTurn
              ? null
              : Stat({
                  k: 'avg-turn',
                  value: avgTurnMs === null ? '—' : elapsed(avgTurnMs),
                  label: 'avg turn',
                  big: true,
                })}
          </Box>

          {isCostsOpen || isTurn ? (
          <Box key="money" flexDirection="row" alignItems="center" gap={2} flexWrap="wrap">
            {isTurn
              ? Metric({
                  k: 'share',
                  icon: ring(turnPct, GREEN),
                  alt: "the last turn's share of the session",
                  value: `${Math.round(turnPct)}%`,
                  label: 'of session',
                })
              : Metric({
                  k: 'share',
                  icon: ring(sessionPct, GREEN),
                  alt: "this session's share of the project",
                  value: isProject ? `${s.folderSessions ?? 0}` : `${Math.round(sessionPct)}%`,
                  label: isProject ? 'sessions' : 'of project',
                })}
            <Box key="mix" flexDirection="row" alignItems="center" gap={1}>
              {parts.length ? (
                <Svg source={mixBar(parts)} alt={`model mix: ${mixText}`} width={44} height={7} />
              ) : null}
              <Text size="body" dimColor>{mixText}</Text>
            </Box>
            {Stat({ k: 'today', value: money(s.todayCost), label: 'today' })}
            {isTurn
              ? Stat({
                  k: 'avg-turn',
                  value: avgTurnMs === null ? '—' : elapsed(avgTurnMs),
                  label: 'avg turn',
                })
              : null}
          </Box>
          ) : null}
        </Box>
      </Box>
    )
  })
}
