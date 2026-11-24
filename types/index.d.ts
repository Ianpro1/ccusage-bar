export type ModelShare = { name: string; cost: number }

export type UsageSnapshot = {
  /** This session, from ccusage's per-session report. */
  sessionCost: number | null
  sessionTokens: number | null
  /** This folder (all sessions ever run in it). */
  folderCost: number | null
  folderTokens: number | null
  folderSessions: number | null
  /** Today's totals across all projects. */
  todayCost: number | null
  /** Share of input tokens served from the prompt cache, 0 to 100. */
  sessionCacheHit: number | null
  folderCacheHit: number | null
  /** Cost by model, largest first. */
  sessionModels: ModelShare[]
  folderModels: ModelShare[]
  /** This session's last logged request, ms since the epoch (from ccusage). */
  sessionLastActivity?: number | null
  /** True when this session writes its cache for one hour, false for five minutes. */
  sessionCache1h?: boolean | null
  /** When the figures were read, ms since the epoch. */
  fetchedAt: number
  /** Why the last read failed, if it did. */
  error: string | null
}

/** The most recent turn of this session, as Claude Code reported it. */
export type LastTurn = {
  /** USD, Claude Code's estimate. */
  cost: number | null
  durationMs: number
  tools: number
  /** Everything the model read: fresh input + cache writes + cache reads. */
  inputTokens: number
  outputTokens: number
  /** Cache reads as a share of inputTokens, 0 to 100. */
  cacheHit: number | null
  model: string | null
  /** When the turn ended, ms since the epoch. */
  endedAt: number
  /** The cache lifetime the turn wrote with, ms; null when it wrote none. */
  cacheTtlMs: number | null
  isAborted: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'ccusage-bar': {
      snapshot: UsageSnapshot | null
      isHidden: boolean
      scope: 'session' | 'project' | 'turn'
      lastTurn: LastTurn | null
      /** Whether the cost row is open; it starts open. */
      costsOpen: boolean
    }
  }
}
