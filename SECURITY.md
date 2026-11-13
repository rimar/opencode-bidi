# Security policy

## Scope

This plugin attaches an AI agent to a running Firefox through WebDriver BiDi.
While attached, the agent can do anything you can do in that browser: read
pages, use cookies and logged-in sessions, and submit forms.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting: open the repository's
**Security** tab and choose **Report a vulnerability**. Do not open a public
issue for a security problem.

Include the version, your OS, steps to reproduce, and the impact you expect.

## Risks worth knowing

- **Prompt injection.** Page content can contain instructions aimed at the
  agent. Treat pages you did not write as untrusted input, and review actions
  that touch money, credentials, or account settings.
- **Existing sessions are opt-in.** A plugin-launched browser uses an isolated
  profile by default. The agent only gets your normal profile when it attaches
  to a Firefox you started, or when `defaultProfile: true` (or
  `FIREFOX_DEFAULT_PROFILE=1`) is set. An
  isolated profile limits the blast radius but is still a browser the agent
  fully controls.
- **`firefox_mask_automation`.** This tool hides `navigator.webdriver` to get
  past bot checks on sites that block automation. Use it only where you would
  browse manually and where doing so does not violate the site's terms.
