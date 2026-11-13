# opencode-firefox

[![npm](https://img.shields.io/npm/v/opencode-firefox?color=2563eb)](https://www.npmjs.com/package/opencode-firefox)
[![CI](https://github.com/rimar/opencode-firefox/actions/workflows/ci.yml/badge.svg)](https://github.com/rimar/opencode-firefox/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Give your OpenCode agent the Firefox you already use.

`opencode-firefox` is an [OpenCode](https://opencode.ai) plugin that drives a
real, running Firefox over **WebDriver BiDi**. No extension, no Playwright, no
Selenium, no separate browser profile — just the browser with your cookies and
logins in it.

```text
you:    book the cheapest direct flight on Friday
agent:  firefox_navigate → firefox_snapshot → firefox_click → firefox_fill
        (already signed in, no login wall, no CAPTCHA detour)
```

## Why

- **Your session, not a sandbox.** It attaches to the Firefox you are already
  using, so sites you are signed in to stay signed in.
- **Zero browser tooling.** One WebSocket to Firefox's BiDi endpoint and plain
  JavaScript in the page. No driver to install, no extension to keep updated,
  no Playwright version to match.
- **Made for agents.** A compact page snapshot with numbered refs (`e0`, `e1`,
  …) that `click` and `fill` accept, plus visible text. Small, stable tool
  surface instead of a giant automation API.
- **Firefox-first.** Firefox stopped shipping CDP; most "AI browser" tooling
  still assumes Chrome. This speaks the protocol Firefox actually exposes.

## Requirements

- Firefox 100 or newer (WebDriver BiDi)
- OpenCode 2.x
- Linux, macOS, or Windows. Tested on Linux; the macOS/Windows paths use the
  standard Firefox install locations and `taskkill` for restart.

## Install

Add the plugin to your OpenCode configuration:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-firefox"]
}
```

OpenCode installs the package automatically. To use a local checkout instead:

```jsonc
{
  "plugins": ["/absolute/path/to/opencode-firefox"]
}
```

Then start Firefox with the debugging port open:

```sh
firefox --remote-debugging-port 9222
```

You can also ask the agent to run `firefox_start` and it will launch Firefox for
you. If Firefox is **already running without the flag**, a new launch forwards
to the existing instance and the port never opens — quit Firefox first, or use
`firefox_restart`.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `FIREFOX_BIDI_PORT` | `9222` | Debugging port |
| `FIREFOX_BIN` | auto-detected | Firefox executable (set it if your install is elsewhere) |
| `FIREFOX_PROFILE` | Firefox default | Optional `-profile` directory for the launched instance |

## Tools

All tools live in the `firefox` namespace and are also available in Code Mode
as `tools.firefox.*`.

| Tool | Purpose |
|---|---|
| `firefox_status` | Port/session/tab health check; attaches if needed |
| `firefox_start` | Launch Firefox with debugging if it is not running |
| `firefox_restart` | Kill and relaunch Firefox, reopening the current page |
| `firefox_navigate` | Open a URL, optionally in a new tab |
| `firefox_snapshot` | URL, title, numbered interactive elements (`e0`, `e1`, …), visible text |
| `firefox_click` | Click by ref, CSS selector, or visible text / aria-label |
| `firefox_fill` | Fill input/textarea/select; optionally submit with Enter |
| `firefox_press` | Enter, Tab, Escape, arrows, PageDown, … |
| `firefox_eval` | Evaluate JavaScript in the page and return JSON |
| `firefox_screenshot` | Save a PNG to disk (open it with the `read` tool) |
| `firefox_tabs` | List, switch, or close tabs |
| `firefox_bidi` | Escape hatch for any raw BiDi command |
| `firefox_mask_automation` | Hide `navigator.webdriver` for sites that block automation |

Typical loop:

```text
firefox_navigate → firefox_snapshot → firefox_click / firefox_fill → firefox_snapshot
```

Take a fresh snapshot before clicking by ref, because refs point at the page
state from the last snapshot.

## Security

This plugin deliberately gives the agent the same reach as your browsing
session: cookies, logged-in accounts, and any site you can open. A malicious or
compromised page can try to prompt-inject the agent into acting on your behalf.

- Prefer sites you trust, and review actions on sensitive accounts.
- If you do not need your real session, run Firefox with a dedicated profile
  (`FIREFOX_PROFILE=/path/to/profile`, or `firefox -P`) instead of your default
  one.
- `firefox_mask_automation` exists because some legitimate sites (airlines,
  banks) block automated browsers outright. It changes only `navigator.webdriver`
  for the current session; use it only where you would browse manually.

Please report security issues privately via GitHub's **Security → Report a
vulnerability** flow, not a public issue. See [SECURITY.md](SECURITY.md).

## Notes and limitations

- Firefox allows **one** BiDi session at a time, and it does not release the
  session when a client disconnects. If OpenCode is killed hard, the next
  connection fails with `Maximum number of active sessions`; `firefox_restart`
  clears it.
- `firefox_restart` kills every Firefox process (`pkill -x firefox` /
  `taskkill /IM firefox.exe /F`) and reopens the last URL. Other tabs are lost —
  use it only to recover.
- The plugin has no network interception, download handling, or multi-browser
  abstraction. It is a small, intentionally direct Firefox driver.
- Firefox stopped shipping CDP, so Chrome DevTools-based tooling cannot attach
  to the debugging port.

## How it works

Firefox exposes WebDriver BiDi at `ws://127.0.0.1:9222/session`. The plugin opens
one WebSocket, creates a session, and sends commands such as
`browsingContext.navigate`, `script.evaluate`, `input.performActions`, and
`browsingContext.captureScreenshot`. Page helpers (snapshot, click, fill) are
JavaScript evaluated in the page, which is why there is nothing else to install.

## Development

```sh
npm install
npm run check   # typecheck + tests
```

To try a local checkout in OpenCode, point `plugins` at the repository
directory (see [Install](#install)) or link it with `npm link`.

## License

MIT — see [LICENSE](LICENSE).
