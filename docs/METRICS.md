# ccusage-bar metrics

What the mod records, where it lives, and how to compare things with it
(an add-on, an MCP server, a skill, a model mix) without fooling yourself.

## Where it is

- **Store:** `~/.claude/plugins/data/ccusage-bar-ccusage-bar/metrics.json`
  (the plugin's data folder, `CLAUDE_PLUGIN_DATA`). Capped at 20 MB; past
  that, the oldest sessions are folded into daily totals.
- **The mod's own turn records:** `turns/<session id>.json` in the same
  folder (exact turn times, MCP servers connected, add-ons available).
  Merged into the store by every build, deleted 60 days after a session's
  last turn.
- **How it fills:** `dashboard/build.mjs` reads Claude Code's logs
  (`~/.claude/projects`), re-reading only logs that changed, and merges the
  mod's records. The mod runs it once a day in the background and whenever
  the dashboard opens. Claude Code deletes logs after 30 days; the store
  keeps them.
- **To analyse:** `dashboard/metrics.mjs`.
  `node dashboard/metrics.mjs --refresh` re-imports and prints a summary;
  `loadTurns()` gives one flat row per prompt; `compare()` does a
  within-project comparison.

## One row per prompt (`loadTurns()`)

| Field | Meaning |
|---|---|
| `project`, `projectLabel`, `cwd` | The folder. The desktop app's scratch folders are one project, `desktop-scratch`. |
| `session`, `sessionTitle`, `turnIndex` | The session and the prompt's position in it. |
| `start`, `end`, `date`, `hour` | When (ms since epoch; local date and hour). |
| `human` | A prompt you typed (false: a turn started by a task notification or similar). |
| `promptChars`, `promptSnippet` | Your prompt's length, and its first 100 characters (to find similar tasks). |
| `durationMs`, `durationExact` | Turn time. Exact when the mod timed it; else estimated from the logs: your prompt to Claude's last reply. |
| `aborted` | You stopped the turn. Leave these out of time comparisons. |
| `idleBeforeMs`, `cacheLikelyExpired` | Gap since the previous turn ended; whether it outlasted the session's prompt-cache lifetime (1 h or 5 min). An expired cache makes a turn pay to re-read the conversation. |
| `cost` | USD: ccusage's per-session, per-model cost split across turns by token weight. Subagents included. |
| `tokensFreshInput`, `tokensCacheWrite`, `tokensCacheWrite1h`, `tokensCacheRead`, `tokensOutput`, `tokensTotal` | Tokens, all requests of the turn (subagents included). |
| `contextTokens` | The context: what the main conversation's largest request read. |
| `costByModel`, `costByFamily`, `leadModel`, `leadFamily` | Cost per model; the model that cost most. |
| `families`, `mixedPrompt` | Model families that did 5%+ of the turn's cost; true when two or more did. |
| `sessionFamilies`, `mixedSession` | The same for the whole session. |
| `effort` | The effort level of the main conversation's responses (`low`…`max`). |
| `subagentCost`, `subagentShare`, `subagentTokens`, `subagentModels` | The part of the turn done by subagents. Mixed-model prompts are usually an Opus prompt with Sonnet or Haiku subagents. |
| `toolCalls`, `tools` | Tool calls, and counts per built-in tool (`Read`, `Grep`, `Bash`, `Edit`…). MCP calls are in `mcp`. |
| `toolErrors` | Tool calls that returned an error. |
| `mcp`, `mcpCalls` | MCP calls per server this turn. The app's built-in `ccd_*` servers are left out unless `includeBuiltinMcp`. |
| `skills` | Skills run this turn. |
| `addonsUsed` | Add-ons used this turn (graphify: its skill, a command naming it, or reading/searching `graphify-out`). |
| `addonsInSession`, `mcpInSession`, `skillsInSession`, `mcpConnected` | What the whole session used, and the MCP servers it could reach. |
| `addonsAvailable` | Add-ons the project had (folder present at session start, recorded by the mod; or present now). |
| `pluginsEnabled` | Plugins enabled for the session (by name, e.g. `tokeneconomizer`), read from Claude Code's settings at session start. `null` for sessions from before this was recorded (0.4.2); for those, the plugin's install date is the only clue. |
| `compactions` | Context compactions during the turn. |

`loadSessions()` gives one row per session with totals. Sessions folded into
daily totals have no turn rows.

## Comparing without fooling yourself

These are the traps found so far. Check each before answering "does X save
or waste tokens / cost / time".

1. **Model.** Cost per prompt differs about 5x between Opus and Sonnet, and
   Fable costs about 2x Opus. An add-on that happened to be used in Fable
   sessions looks expensive. Compare within one `leadFamily` (or within
   `families.length === 1` prompts of one family).
2. **Project.** Projects differ a lot in size and task. Compare within
   projects (`compare()` does this) and say how many projects the answer
   rests on.
3. **Setup cost.** An add-on's first sessions often build or install it
   (graphify building its graph). Report those separately from steady use.
4. **Task size.** Bigger tasks cost more whatever tools they use. Normalize
   by `contextTokens` or `promptChars`, or look at `promptSnippet` to compare
   similar tasks.
5. **Cache expiry.** Turns after a long break pay to rebuild the cache.
   `cacheLikelyExpired` lets you leave them out or compare them apart.
6. **Median vs mean.** The median says what a typical prompt costs; the mean
   (or total) is what a usage limit feels. Give both when they differ.
7. **Sample size.** Say how many prompts and projects each side has. Under
   about 30 prompts a side, or one project, call it a hint.
8. **Time trend.** Before/after comparisons also pick up everything else that
   changed (models, tasks). Prefer with/without in the same period.

For a plugin that works in the background through hooks (TokenEconomizer:
injected repo facts, pruned tools, a failing-loop guard), there are no calls
to spot: compare on `pluginsEnabled`, and look at `contextTokens`,
`tokensCacheWrite` on a session's first turn, `toolErrors` and `durationMs`.
Fair comparisons need sessions with it off, in the same projects and period.

For an add-on, useful measures beyond cost: `tools.Read + tools.Grep +
tools.Glob` (does it cut file searching?), `tokensTotal`, `contextTokens`,
`durationMs`, `toolErrors`. Compare sessions where it was available but unused
(`addonsAvailable` without `addonsInSession`) with sessions that used it.
