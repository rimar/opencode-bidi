# Contributing

Thanks for taking a look. Bug reports and pull requests are welcome.

## Before opening a PR

```sh
pnpm install
pnpm check   # typecheck + tests
```

- Keep the plugin dependency-free at runtime. If a change needs a library,
  explain why in the PR.
- Keep tools small and agent-friendly: JSON Schema inputs, plain text output,
  and errors that tell the model what to do next.
- Test against a real Firefox with `--remote-debugging-port 9222` when you
  change page helpers. Include the current URL and what you did in the PR.

## Manual testing

```sh
firefox --remote-debugging-port 9222
```

Point OpenCode at your checkout:

```jsonc
{
  "plugins": ["/absolute/path/to/opencode-firefox"]
}
```

Then exercise `firefox_status`, `firefox_navigate`, `firefox_snapshot`,
`firefox_click`, and `firefox_fill` against a page you control.
