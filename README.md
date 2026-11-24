# ccusage-bar

A clean usage bar above the prompt in Claude Code, powered by [ccusage](https://github.com/ryoppippi/ccusage).

It shows what your Claude Code sessions cost and how they use tokens, for this session, this project folder, or just the last turn, with a small animated character, Tally, that reacts to how full your context is.

```
(Tally)  ccusage ✓ All clear.                    Session · Project · Last turn  ↻
         6.8M tokens   ◕ 94% cache hit   ◕ 48m cache   ◔ 31% context
         S $3.11 session  ◔ 65% of project  ▬▬▬ Opus 92% · Sonnet 8%  $17.30 today  +$0.42 last turn
```

## What it shows

**Top row**
- **tokens:** every token the session or project used (input, output, cache writes and cache reads).
- **cache hit:** the share of input served from the prompt cache, which costs about a tenth of normal input. Higher is better.
- **cache:** time left before the prompt cache expires (1 hour on subscriptions, 5 minutes on the API). Your next message after it runs out pays full price to re-read the conversation.
- **context:** how full the context window is. Near 100%, Claude Code compacts the conversation.

**Cost row**
- **S / P / L:** the cost of this session, this project folder, or the last turn.
- **of project / sessions / of session:** this session's share of the project, the project's session count, or the last turn's share of the session.
- **Model mix:** how the cost splits between Opus, Sonnet and Haiku.
- **today:** everything since midnight, across all projects.
- **last turn:** what your most recent message cost.

**Last turn view:** how long the turn took, how many tool calls it made, the tokens it read (in) and wrote (out), and its cache hit rate.

**Tally**, the character, bobs and blinks normally, turns worried at 70% context and alarmed at 85%, and looks busy while Claude is working.

All costs are estimates from your local logs; your bill is the authority.

## Requirements

- Claude Code with mod support. The full bar with gauges and Tally draws in the Claude desktop app; terminals get a compact text line.
- [ccusage](https://github.com/ryoppippi/ccusage) installed and on your PATH:

  ```
  npm install -g ccusage
  ```

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install ccusage-bar --marketplace Ianpro1/ccusage-bar
```

Answer `y` to add the marketplace, then pick a scope.

From a shell:

```
claude plugin install ccusage-bar --marketplace Ianpro1/ccusage-bar
```

In the desktop app, where `/plugin` does not run: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `Ianpro1/ccusage-bar`, then **Add plugin**.

## Commands

- `/ccusage-bar hide` hides the bar.
- `/ccusage-bar show` brings it back.
- `/ccusage-bar refresh` re-reads the figures (they also refresh every minute and after each turn).

## Credits

Built with Claude Code. Usage figures come from ccusage by ryoppippi. The layout is inspired by the status bar of [token-optimizer](https://github.com/alexgreensh/token-optimizer); the code and the Tally character are original.
