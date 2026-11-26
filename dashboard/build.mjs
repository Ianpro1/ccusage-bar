#!/usr/bin/env node
// ccusage-bar dashboard builder.
//
// 1. Imports Claude Code's session logs (~/.claude/projects) into a store of
//    per-turn records, re-reading only the logs that changed since last time.
// 2. Merges in the turns the mod recorded itself (exact turn times).
// 3. Splits ccusage's per-session, per-model cost across the turns.
// 4. Keeps the store under a size cap by folding the oldest sessions' turns
//    into daily totals.
// 5. Writes a static dashboard page with the data built in, and opens it.
//
// The store outlives Claude Code's own logs (which it deletes after 30 days
// by default), so the dashboard keeps your history.
//
// Usage: node build.mjs [--data <dir>] [--projects <dir>] [--cap-mb 20] [--open] [--page compare]

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { execFile, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
// 2: prompt length (pc) and context size (cx) per turn
// 3: prompt snippet (pt), effort (ef), tool errors (er), compactions (cp),
//    tool counts (tl), add-ons used (ad) and subagent usage (sm) per turn
const STORE_VERSION = 5 // 4: compactions before a log's first prompt count toward it; 5: compaction summaries are not prompts

const args = parseArgs(process.argv.slice(2))
const HOME = os.homedir()
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude')
const DATA = args.data || process.env.CLAUDE_PLUGIN_DATA || path.join(CLAUDE_DIR, 'ccusage-bar')
const PROJECTS = args.projects || path.join(CLAUDE_DIR, 'projects')
const CAP = (Number(args['cap-mb']) || 20) * 1024 * 1024
const STORE_FILE = path.join(DATA, 'metrics.json')
const MOD_TURNS = path.join(DATA, 'turns')
const PAGE_FILE = path.join(DATA, 'dashboard.html')
const COMPARE_FILE = path.join(DATA, 'compare.html')

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const key = a.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) out[key] = true
    else { out[key] = next; i++ }
  }
  return out
}

const log = (...m) => { if (!args.quiet) console.error('[dashboard]', ...m) }

// ---- the add-ons the legend names --------------------------------------------
// Each is found by a skill it runs, a word in a shell command, an MCP server,
// or a folder it leaves in the project. Add more here.
const ADDONS = [
  // `path`: a file read or searched under it counts as using the add-on (its output)
  { id: 'graphify', label: 'graphify', skills: ['graphify'], command: /\bgraphify\b/i, path: /graphify-out/i, folder: 'graphify-out' },
]

// ---- cost: fallback prices when ccusage has no figure ------------------------
// $ per million input tokens; output is 5x, cache writes 1.25x (5 min) or
// 2x (1 h), cache reads 0.1x. Only used where ccusage can't price a session.
const FALLBACK_PRICES = [
  [/(fable|mythos)-5-2/, 8], [/fable|mythos/, 10],
  [/opus-5-5/, 4], [/opus-(5|4-[5-9])/, 5], [/opus/, 15],
  [/sonnet-5/, 2], [/sonnet/, 3],
  [/haiku-5/, 0.1], [/haiku-4/, 1], [/haiku/, 0.8],
]
const inputPrice = model => (FALLBACK_PRICES.find(([re]) => re.test(model)) ?? [null, 3])[1]

// usage array per model: [input, cacheWrite, cacheRead, output, cacheWrite1h, cost]
const IN = 0, CW = 1, CR = 2, OUT = 3, CW1H = 4, COST = 5
// relative price of each kind of token, the same ratios for every Claude model
const weight = u => u[IN] + (u[CW] - u[CW1H]) * 1.25 + u[CW1H] * 2 + u[CR] * 0.1 + u[OUT] * 5

// ---- reading one session's logs -----------------------------------------------

const ts = o => {
  const t = Date.parse(o.timestamp ?? '')
  return Number.isFinite(t) ? t : null
}

function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter(b => b?.type === 'text').map(b => b.text ?? '').join('')
}

async function* records(file) {
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity })
  for await (const line of rl) {
    if (line.length < 2 || line[0] !== '{') continue
    // Request blobs are large and hold nothing we read.
    if (line.startsWith('{"type":"api-request') || line.startsWith('{"type":"data-flow')) continue
    try { yield JSON.parse(line) } catch { /* a torn last line */ }
  }
}

function newTurn(start, origin, promptChars = 0, snippet = null) {
  return {
    s: start, last: start, o: origin, a: 0, pc: promptChars, pt: snippet,
    m: {}, n: 0, mcp: {}, sk: {}, tl: {}, ad: {}, er: 0, cp: 0, ef: null, usage: new Map(),
  }
}

// Records a tool call on a turn and on the session's totals.
function addTool(session, turn, name, input, seen, id) {
  if (id) { if (seen.has(id)) return; seen.add(id) }
  turn.n++
  if (name.startsWith('mcp__')) {
    const server = name.split('__')[1] || 'mcp'
    turn.mcp[server] = (turn.mcp[server] ?? 0) + 1
    session.mcp[server] = (session.mcp[server] ?? 0) + 1
  } else {
    session.tools[name] = (session.tools[name] ?? 0) + 1
    turn.tl[name] = (turn.tl[name] ?? 0) + 1
  }
  if (name === 'Skill' && input?.skill) {
    const skill = String(input.skill).replace(/^\//, '')
    turn.sk[skill] = (turn.sk[skill] ?? 0) + 1
    session.skills[skill] = (session.skills[skill] ?? 0) + 1
  }
  if ((name === 'Agent' || name === 'Task') && input?.subagent_type) {
    const agent = String(input.subagent_type)
    session.agents[agent] = (session.agents[agent] ?? 0) + 1
  }
  const command = (name === 'Bash' || name === 'PowerShell') ? String(input?.command ?? '') : ''
  const target = String(input?.file_path ?? input?.path ?? input?.notebook_path ?? '')
  for (const a of ADDONS) {
    if ((a.skills && input?.skill && a.skills.includes(String(input.skill).replace(/^\//, ''))) ||
        (a.command && command && a.command.test(command)) ||
        (a.path && target && a.path.test(target)) ||
        (a.mcp && name.startsWith(`mcp__${a.mcp}__`))) {
      session.addons[a.id] = true
      turn.ad[a.id] = (turn.ad[a.id] ?? 0) + 1
    }
  }
}

function addUsage(turn, key, model, u) {
  // A response is logged once per content block, each with the usage so far:
  // keep the last, so each response counts once with its final figures.
  turn.usage.set(key, [model, [
    u.input_tokens ?? 0,
    u.cache_creation_input_tokens ?? 0,
    u.cache_read_input_tokens ?? 0,
    u.output_tokens ?? 0,
    u.cache_creation?.ephemeral_1h_input_tokens ?? 0,
    0,
  ]])
}

async function parseSession(id, mainFile, sideFiles) {
  const session = {
    id, cwd: null, title: null, prompt: null, ver: null, ep: null,
    first: null, last: null, turns: [],
    tools: {}, mcp: {}, skills: {}, agents: {}, addons: {},
  }
  const toolIds = new Set()
  let turn = null
  let titleIsCustom = false
  let pendingCompactions = 0

  for await (const o of records(mainFile)) {
    if (o.type === 'custom-title' && o.customTitle) { session.title = o.customTitle; titleIsCustom = true; continue }
    if (o.type === 'agent-name' && o.agentName && !titleIsCustom) { session.title = o.agentName; continue }
    if (o.type === 'summary' && o.summary && !session.title) { session.title = o.summary; continue }
    if (o.type === 'system' && o.subtype === 'compact_boundary') {
      session.compactions = (session.compactions ?? 0) + 1
      // counts toward the turn under way, or the next one when none is
      if (turn) turn.cp++
      else pendingCompactions++
      continue
    }
    if (o.type !== 'user' && o.type !== 'assistant') continue
    const t = ts(o)
    if (t === null) continue
    if (!session.cwd && o.cwd) session.cwd = o.cwd
    if (o.version) session.ver = o.version
    if (!session.ep && o.entrypoint) session.ep = o.entrypoint

    if (o.type === 'user') {
      const content = o.message?.content
      const isResult = Array.isArray(content) && content.some(b => b?.type === 'tool_result')
      if (isResult || o.isSidechain) {
        if (turn) {
          turn.last = Math.max(turn.last, t)
          if (isResult) turn.er += content.filter(b => b?.type === 'tool_result' && b.is_error).length
        }
        continue
      }
      const text = textOf(content)
      if (/^\[Request interrupted by user/.test(text)) { if (turn) turn.a = 1; continue }
      // a compaction's summary is logged as a user message (with an older
      // timestamp); it belongs to the turn under way, not a new prompt
      if (o.isMeta || o.isCompactSummary || o.isVisibleInTranscriptOnly) continue
      if (/^<(local-command-stdout|local-command-caveat|command-stdout|bash-stdout)/.test(text)) continue
      const kind = o.origin?.kind
      const isHuman = kind === undefined || kind === 'human'
      const snippet = isHuman && !text.startsWith('<') ? text.replace(/\s+/g, ' ').trim().slice(0, 100) : null
      turn = newTurn(t, isHuman ? 'h' : 'x', isHuman ? text.length : 0, snippet)
      turn.cp += pendingCompactions
      pendingCompactions = 0
      session.turns.push(turn)
      if (!session.prompt && turn.o === 'h' && !text.startsWith('<')) session.prompt = text.replace(/\s+/g, ' ').trim().slice(0, 90)
      continue
    }

    // assistant
    const msg = o.message
    if (!msg) continue
    if (!turn) { turn = newTurn(t, 'x'); session.turns.push(turn) }
    turn.last = Math.max(turn.last, t)
    if (o.effort && !o.isSidechain) turn.ef = o.effort
    for (const b of Array.isArray(msg.content) ? msg.content : []) {
      if (b?.type === 'tool_use' && b.name) addTool(session, turn, b.name, b.input, toolIds, b.id)
    }
    if (msg.usage && msg.model && msg.model !== '<synthetic>') {
      // older logs kept subagents' responses inline, marked as a sidechain
      addUsage(turn, `${o.isSidechain ? 'sub:' : ''}${msg.id ?? ''}:${o.requestId ?? ''}`, msg.model, msg.usage)
    }
  }

  // Subagents: their requests count toward the turn that was running then.
  const starts = session.turns.map(x => x.s)
  const turnAt = t => {
    let lo = 0, hi = starts.length - 1, at = -1
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (starts[mid] <= t) { at = mid; lo = mid + 1 } else hi = mid - 1 }
    return at >= 0 ? session.turns[at] : null
  }
  for (const file of sideFiles) {
    for await (const o of records(file)) {
      if (o.type !== 'assistant' || !o.message) continue
      const t = ts(o)
      const owner = t === null ? null : turnAt(t)
      if (!owner) continue
      for (const b of Array.isArray(o.message.content) ? o.message.content : []) {
        if (b?.type === 'tool_use' && b.name) addTool(session, owner, b.name, b.input, toolIds, b.id)
      }
      const msg = o.message
      if (msg.usage && msg.model && msg.model !== '<synthetic>') {
        addUsage(owner, `sub:${msg.id ?? ''}:${o.requestId ?? ''}`, msg.model, msg.usage)
      }
    }
  }

  // Fold each turn's responses into per-model totals (sm: the subagents'
  // share of them); drop turns that never reached the model (a local
  // command, a /clear).
  const out = []
  for (const x of session.turns) {
    x.cx = 0
    x.sm = {}
    for (const [key, [model, u]] of x.usage) {
      const acc = x.m[model] ??= [0, 0, 0, 0, 0, 0]
      for (let i = 0; i < 5; i++) acc[i] += u[i]
      if (key.startsWith('sub:')) {
        const sub = x.sm[model] ??= [0, 0, 0, 0, 0, 0]
        for (let i = 0; i < 5; i++) sub[i] += u[i]
      } else {
        // the context: what the main conversation's largest request read
        x.cx = Math.max(x.cx, u[IN] + u[CW] + u[CR])
      }
    }
    if (Object.keys(x.m).length === 0) continue
    out.push(compactTurn(x))
  }
  session.turns = out
  session.first = out[0]?.s ?? null
  session.last = out.length ? Math.max(...out.map(x => x.s + (x.d ?? 0))) : null
  return session
}

function compactTurn(x) {
  const t = { s: x.s, d: Math.max(0, x.last - x.s), m: x.m }
  if (x.o !== 'h') t.o = x.o
  if (x.a) t.a = 1
  if (x.n) t.n = x.n
  if (x.pc) t.pc = x.pc
  if (x.pt) t.pt = x.pt
  if (x.cx) t.cx = x.cx
  if (x.ef) t.ef = x.ef
  if (x.er) t.er = x.er
  if (x.cp) t.cp = x.cp
  if (Object.keys(x.tl).length) t.tl = x.tl
  if (Object.keys(x.mcp).length) t.mcp = x.mcp
  if (Object.keys(x.sk).length) t.sk = x.sk
  if (Object.keys(x.ad).length) t.ad = x.ad
  if (Object.keys(x.sm).length) t.sm = x.sm
  return t
}

// ---- finding the logs -----------------------------------------------------------

async function listDir(dir) {
  try { return await fsp.readdir(dir, { withFileTypes: true }) } catch { return [] }
}

async function statOf(file) {
  try { const s = await fsp.stat(file); return { mtimeMs: Math.round(s.mtimeMs), size: s.size } } catch { return null }
}

async function firstSessionId(file) {
  for await (const o of records(file)) if (o.sessionId) return o.sessionId
  return null
}

// Every session found: its main log, its subagents' logs, and their stamps.
async function findSessions() {
  const found = new Map()
  const entry = id => { if (!found.has(id)) found.set(id, { main: null, side: [] }); return found.get(id) }
  for (const p of await listDir(PROJECTS)) {
    if (!p.isDirectory()) continue
    const dir = path.join(PROJECTS, p.name)
    for (const f of await listDir(dir)) {
      const full = path.join(dir, f.name)
      if (f.isFile() && f.name.endsWith('.jsonl')) {
        if (f.name.startsWith('agent-')) {
          // older Claude Code kept subagent logs beside the session's
          const id = await firstSessionId(full)
          if (id) entry(id).side.push(full)
        } else entry(f.name.slice(0, -6)).main = full
      } else if (f.isDirectory()) {
        for (const s of await listDir(path.join(full, 'subagents'))) {
          if (s.isFile() && s.name.endsWith('.jsonl')) entry(f.name).side.push(path.join(full, 'subagents', s.name))
        }
      }
    }
  }
  for (const [id, e] of found) {
    if (!e.main) { found.delete(id); continue }
    const stamps = {}
    for (const f of [e.main, ...e.side]) stamps[f] = await statOf(f)
    e.stamp = JSON.stringify(stamps)
  }
  return found
}

// ---- ccusage costs ---------------------------------------------------------------

function ccusageSessions() {
  return new Promise(resolve => {
    const isWin = process.platform === 'win32'
    const cmd = isWin ? 'cmd.exe' : 'ccusage'
    const argv = isWin ? ['/d', '/s', '/c', 'ccusage session --json --offline'] : ['session', '--json', '--offline']
    execFile(cmd, argv, { maxBuffer: 256 * 1024 * 1024, timeout: 120_000, windowsHide: true }, (err, stdout) => {
      if (err) { log('ccusage unavailable, using fallback prices:', String(err.message).split('\n')[0]); return resolve(null) }
      try {
        const rows = JSON.parse(stdout).session ?? []
        const byId = new Map()
        for (const r of rows) {
          const costs = {}
          for (const b of r.modelBreakdowns ?? []) if (b.modelName) costs[b.modelName] = (costs[b.modelName] ?? 0) + (b.cost ?? 0)
          byId.set(r.period ?? r.sessionId, costs)
        }
        resolve(byId)
      } catch (e) { log('could not read ccusage output:', e.message); resolve(null) }
    })
  })
}

function priceSession(session, costs) {
  const turns = session.turns ?? []
  const totals = {}
  for (const t of turns) for (const [model, u] of Object.entries(t.m)) totals[model] = (totals[model] ?? 0) + weight(u)
  for (const t of turns) {
    for (const [model, u] of Object.entries(t.m)) {
      if (t.x && u[COST] > 0 && !costs?.[model]) continue // the mod's own figure
      const c = costs?.[model]
      u[COST] = c !== undefined && totals[model] > 0
        ? (c * weight(u)) / totals[model]
        : (weight(u) * inputPrice(model)) / 1e6
    }
    // the subagents' share, at the same rate as the turn's own figure for that model
    for (const [model, sub] of Object.entries(t.sm ?? {})) {
      const all = t.m[model]
      sub[COST] = all && weight(all) > 0 ? (all[COST] * weight(sub)) / weight(all) : 0
    }
  }
}

// ---- the mod's own turn records -------------------------------------------------

async function readModTurns() {
  const bySession = new Map()
  for (const f of await listDir(MOD_TURNS)) {
    if (!f.isFile() || !f.name.endsWith('.json')) continue
    try {
      const rec = JSON.parse(await fsp.readFile(path.join(MOD_TURNS, f.name), 'utf8'))
      if (rec?.sessionId && Array.isArray(rec.turns)) bySession.set(rec.sessionId, rec)
    } catch { /* a file mid-write; next build reads it */ }
  }
  return bySession
}

// Exact times from the mod replace the log's estimates; turns the logs no
// longer hold are added from the mod's record.
function mergeModTurns(session, rec) {
  if (!session.cwd && rec.cwd) session.cwd = rec.cwd
  const turns = session.turns ?? (session.turns = [])
  for (const r of rec.turns) {
    const start = r.e - r.d
    let best = null, bestGap = 20_000
    for (const t of turns) {
      const gap = Math.abs(t.s - start)
      if (gap < bestGap) { best = t; bestGap = gap }
    }
    if (best) {
      best.d = r.d; best.x = 1
      if (r.a) best.a = 1; else delete best.a
      if (r.mcp && !best.mcp) best.mcp = r.mcp
      continue
    }
    const t = { s: start, d: r.d, x: 1, m: {} }
    if (r.a) t.a = 1
    if (r.n) t.n = r.n
    if (r.mcp && Object.keys(r.mcp).length) t.mcp = r.mcp
    if (r.sk && Object.keys(r.sk).length) t.sk = r.sk
    const tokens = Object.values(r.m ?? {}).reduce((a, u) => a + weight([...u, 0, 0].slice(0, 6)), 0)
    for (const [model, u] of Object.entries(r.m ?? {})) {
      const arr = [u[0] ?? 0, u[1] ?? 0, u[2] ?? 0, u[3] ?? 0, u[4] ?? 0, 0]
      arr[COST] = r.c != null && tokens > 0 ? (r.c * weight(arr)) / tokens : 0
      t.m[model] = arr
    }
    if (Object.keys(t.m).length) turns.push(t)
    for (const s of Object.keys(r.sk ?? {})) session.skills[s] = (session.skills[s] ?? 0) + r.sk[s]
    for (const m of Object.keys(r.mcp ?? {})) session.mcp[m] = (session.mcp[m] ?? 0) + r.mcp[m]
  }
  for (const s of rec.mcpConnected ?? []) (session.mcpConnected ??= {})[s] = true
  for (const a of rec.addonsPresent ?? []) (session.addonsPresent ??= {})[a] = true
  for (const p of rec.pluginsEnabled ?? []) (session.pluginsEnabled ??= {})[p] = true
  turns.sort((a, b) => a.s - b.s)
  session.first = turns[0]?.s ?? session.first
  session.last = turns.length ? Math.max(session.last ?? 0, ...turns.map(x => x.s + (x.d ?? 0))) : session.last
}

// ---- size cap: fold the oldest sessions into daily totals ------------------------

const dayOf = ms => { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() }

function foldSession(session) {
  const days = new Map()
  for (const t of session.turns ?? []) {
    const key = dayOf(t.s)
    const d = days.get(key) ?? { s: key, k: 0, dk: 0, d: 0, ab: 0, n: 0, m: {}, mcp: {} }
    d.k++
    if (t.a) d.ab++; else { d.dk++; d.d += t.d ?? 0 }
    d.n += t.n ?? 0
    for (const [model, u] of Object.entries(t.m)) {
      const acc = d.m[model] ??= [0, 0, 0, 0, 0, 0]
      for (let i = 0; i < 6; i++) acc[i] += u[i] ?? 0
    }
    for (const [srv, c] of Object.entries(t.mcp ?? {})) d.mcp[srv] = (d.mcp[srv] ?? 0) + c
    days.set(key, d)
  }
  session.days = [...(session.days ?? []), ...days.values()].sort((a, b) => a.s - b.s)
  delete session.turns
}

function enforceCap(store) {
  let size = Buffer.byteLength(JSON.stringify(store))
  if (size <= CAP) return 0
  const oldest = Object.values(store.sessions).filter(s => s.turns?.length).sort((a, b) => (a.last ?? 0) - (b.last ?? 0))
  let folded = 0
  for (const s of oldest) {
    if (size <= CAP * 0.9) break
    const before = Buffer.byteLength(JSON.stringify(s))
    foldSession(s)
    size -= before - Buffer.byteLength(JSON.stringify(s))
    folded++
  }
  return folded
}

// ---- projects ----------------------------------------------------------------------

const SCRATCH = /[\\/]Claude[\\/](Data[\\/][^\\/]+[\\/])?scratch[\\/]?|[\\/]scratch-workspaces[\\/]|[\\/]AppData[\\/](Local|Roaming)[\\/]Claude[\\/]/i

function projectOf(cwd) {
  if (!cwd) return { key: '(unknown)', label: 'Unknown folder', path: '' }
  if (SCRATCH.test(cwd)) return { key: 'desktop-scratch', label: 'Desktop scratch', path: 'Temporary workspaces of the desktop app' }
  const norm = process.platform === 'win32' ? cwd.toLowerCase() : cwd
  const label = cwd.split(/[\\/]/).filter(Boolean).pop() || cwd
  return { key: norm, label, path: cwd }
}

// ---- main ----------------------------------------------------------------------------

async function loadStore() {
  try {
    const s = JSON.parse(await fsp.readFile(STORE_FILE, 'utf8'))
    if (s?.sessions) {
      // An older store: re-read every log still on disk to fill the new
      // fields; sessions whose logs are gone keep what they had.
      if (s.version !== STORE_VERSION) { s.stamps = {}; s.version = STORE_VERSION }
      return s
    }
  } catch { /* first run */ }
  return { version: STORE_VERSION, stamps: {}, sessions: {} }
}

// ---- project size, as it stands now ----------------------------------------------
// Files and bytes under the folder, leaving out what tools generate
// (.git, node_modules, build output). Bounded, so a huge folder stays quick.
const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', 'dist', 'build', 'target', '.next', 'Library', 'Temp', 'obj', '.cache'])
const SIZE_LIMIT = 50_000

async function projectSize(dir) {
  let files = 0, bytes = 0, isPartial = false
  const stack = [dir]
  while (stack.length) {
    const d = stack.pop()
    for (const e of await listDir(d)) {
      if (files >= SIZE_LIMIT) { isPartial = true; break }
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) stack.push(path.join(d, e.name)) }
      else if (e.isFile()) {
        files++
        try { bytes += (await fsp.stat(path.join(d, e.name))).size } catch { }
      }
    }
    if (isPartial) break
  }
  return { files, bytes, isPartial }
}

async function main() {
  const t0 = Date.now()
  await fsp.mkdir(DATA, { recursive: true })
  const store = await loadStore()
  const found = await findSessions()
  const changed = [...found].filter(([id, e]) => store.stamps[id] !== e.stamp || !store.sessions[id])
  log(`${found.size} sessions in the logs, ${changed.length} new or changed`)

  let done = 0
  for (const [id, e] of changed) {
    try {
      const s = await parseSession(id, e.main, e.side)
      const old = store.sessions[id]
      if (old?.days) s.days = old.days.filter(d => !s.turns.length || d.s < dayOf(s.turns[0].s))
      if (s.turns.length || s.days?.length) store.sessions[id] = s
      else delete store.sessions[id]
      store.stamps[id] = e.stamp
    } catch (err) { log(`skipped ${id}: ${err.message}`) }
    if (++done % 25 === 0) log(`read ${done}/${changed.length}`)
  }

  const mod = await readModTurns()
  for (const [id, rec] of mod) {
    const s = store.sessions[id] ?? (store.sessions[id] = {
      id, cwd: rec.cwd ?? null, title: null, prompt: null, first: null, last: null, turns: [],
      tools: {}, mcp: {}, skills: {}, agents: {}, addons: {},
    })
    mergeModTurns(s, rec)
  }

  const costs = await ccusageSessions()
  for (const s of Object.values(store.sessions)) {
    const c = costs?.get(s.id)
    if (c || changed.some(([id]) => id === s.id) || mod.has(s.id)) priceSession(s, c)
  }

  // Add-ons that leave a folder in the project
  const checked = new Map()
  for (const s of Object.values(store.sessions)) {
    if (!s.cwd) continue
    for (const a of ADDONS) {
      if (!a.folder) continue
      const p = path.join(s.cwd, a.folder)
      if (!checked.has(p)) checked.set(p, fs.existsSync(p))
      if (checked.get(p)) (s.projectAddons ??= {})[a.id] = true
    }
  }

  const folded = enforceCap(store)
  if (folded) log(`folded ${folded} old sessions into daily totals to stay under ${CAP / 1024 / 1024} MB`)

  store.builtAt = Date.now()
  await writePage(store) // also measures project sizes into the store

  const storeText = JSON.stringify(store)
  await fsp.writeFile(STORE_FILE + '.tmp', storeText)
  await fsp.rename(STORE_FILE + '.tmp', STORE_FILE)

  // The mod's records of sessions idle for 60 days are in the store now.
  const stale = Date.now() - 60 * 86_400_000
  for (const [id, rec] of mod) {
    const lastEnd = Math.max(0, ...rec.turns.map(t => t.e ?? 0))
    if (lastEnd < stale) await fsp.unlink(path.join(MOD_TURNS, `${id}.json`)).catch(() => {})
  }

  log(`store ${(Buffer.byteLength(storeText) / 1024 / 1024).toFixed(1)} MB, pages written in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
  const page = args.page === 'compare' ? COMPARE_FILE : PAGE_FILE
  console.log(page)
  if (args.open) openFile(page)
}

async function writePage(store) {
  const projects = {}
  const sessions = []
  store.sizes ??= {}
  for (const s of Object.values(store.sessions)) {
    const p = projectOf(s.cwd)
    if (!projects[p.key]) {
      projects[p.key] = { label: p.label, path: p.path }
      // size of the folder now; re-measured at most once a day
      if (p.key !== 'desktop-scratch' && p.path && fs.existsSync(p.path)) {
        const known = store.sizes[p.key]
        if (!known || Date.now() - known.at > 86_400_000) store.sizes[p.key] = { ...(await projectSize(p.path)), at: Date.now() }
        projects[p.key].size = store.sizes[p.key]
      }
    }
    sessions.push({
      id: s.id, p: p.key, title: s.title || s.prompt || null, first: s.first, last: s.last,
      ver: s.ver ?? null, ep: s.ep ?? null,
      turns: s.turns ?? [], days: s.days ?? [],
      tools: s.tools, mcp: s.mcp, skills: s.skills, agents: s.agents,
      addons: Object.keys(s.addons ?? {}), // used in this session
      projectAddons: Object.keys(s.projectAddons ?? {}), // left a folder in the project
      mcpConnected: Object.keys(s.mcpConnected ?? {}),
    })
  }
  sessions.sort((a, b) => (b.last ?? 0) - (a.last ?? 0))
  const data = {
    builtAt: store.builtAt,
    addons: ADDONS.map(a => ({ id: a.id, label: a.label })),
    projects, sessions,
  }
  const json = JSON.stringify(data).replace(/</g, '\\u003c')
  for (const [templateName, out] of [['template.html', PAGE_FILE], ['compare-template.html', COMPARE_FILE]]) {
    const template = await fsp.readFile(path.join(HERE, templateName), 'utf8')
    await fsp.writeFile(out, template.replace('/*__DATA__*/null', () => json))
  }
}

function openFile(file) {
  const opts = { detached: true, stdio: 'ignore', windowsHide: true }
  if (process.platform === 'win32') {
    spawn('cmd.exe', ['/d', '/s', '/c', `start "" "${file}"`], { ...opts, windowsVerbatimArguments: true }).unref()
  } else if (process.platform === 'darwin') spawn('open', [file], opts).unref()
  else spawn('xdg-open', [file], opts).unref()
}

main().catch(err => { console.error('[dashboard] failed:', err?.stack || err); process.exit(1) })
