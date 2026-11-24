# ccusage-bar

A clean usage bar above the prompt in Claude Code, powered by [ccusage](https://github.com/ryoppippi/ccusage).

It shows what your Claude Code sessions cost and how they use tokens, for this session, this project folder, or just the last turn, with a small animated character, Tally, that reacts to how full your context is.

![The ccusage bar in the Claude desktop app, with Tally animating while Claude works](assets/ccusage-bar.gif)

## What it shows

**Header:** **Session**, **Project** and **Last turn** switch the view, and each shows its cost: this session, this project folder, and your most recent message.

**Top row**
- **tokens:** every token the session or project used (input, output, cache writes and cache reads).
- **cache hit:** the share of input served from the prompt cache, which costs about a tenth of normal input. Higher is better.
- **cache:** time left before the prompt cache expires (1 hour on subscriptions, 5 minutes on the API). Your next message after it runs out pays full price to re-read the conversation.
- **context:** how full the context window is. Near 100%, Claude Code compacts the conversation.
- **avg turn:** how long Claude works on a prompt in this session, on average (stopped turns left out). Not shown in Project view.

**Bottom row** (open by default; the ▴ / ▾ arrow at the end of the header hides and shows it)
- **of project / sessions:** this session's share of the project's cost, or the project's session count.
- **Model mix:** how the cost splits between Opus, Sonnet and Haiku.
- **today:** everything since midnight, across all projects.

**Last turn view:** the top row shows how long the turn took, how many tool calls it made, the tokens it read (in) and wrote (out), and its cache hit rate; the bottom row shows its share of the session's cost, its model, today, and the average turn time.

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
