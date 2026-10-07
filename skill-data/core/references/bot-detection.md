# Bot Detection and Site Blocking

What to do when a site blocks the browser: an "Access Denied" title, a CAPTCHA that keeps coming back, or a Cloudflare "Just a moment..." page that never finishes.

**Related**: [proxy-support.md](proxy-support.md) for proxies, [session-management.md](session-management.md) for persistent state, [SKILL.md](../SKILL.md) for quick start.

agent-browser has no built-in stealth mode, by design. Do not promise the user that any option will get past a determined bot filter, and respect the site's terms. Do not try to solve CAPTCHAs yourself; ask the user to complete one in a headed window, or use a CAPTCHA plugin they configured.

## What a default session reveals

| Launch | `navigator.userAgent` | `navigator.webdriver` | UA client hints |
| --- | --- | --- | --- |
| Default (headless) | Contains `HeadlessChrome` | `true` | Sent |
| `--user-agent "<desktop UA>"` | The value passed | `true` | Not sent |
| `--args "--disable-blink-features=AutomationControlled"` | Contains `HeadlessChrome` | `false` | Sent |
| `--headed` | Regular `Chrome` token | `true` | Sent |
| `--cdp` or `--auto-connect` to a Chrome the user started | Regular `Chrome` token | `false` | Sent |

- Headless Chrome sends `HeadlessChrome` in the `User-Agent` header. Many filters block that token, so a page can work with `--headed` and fail headless.
- Chrome reports `navigator.webdriver` as `true` for every browser agent-browser launches, headless or headed.
- Without `--profile`, every launch starts from a fresh temporary profile with no cookies or history. Google and similar sites challenge new browsers more often.
- `--user-agent` also stops Chrome from sending `Sec-CH-UA` client hints, which stricter filters notice.
- Chrome for Testing (from `agent-browser install`) reports the `Chromium` brand. `--executable-path` can point at a regular Chrome install.

## Escalation order

Launch flags apply when the browser starts. A command whose launch flags differ from the running browser relaunches it, so the current page and any unsaved state are lost.

```bash
# 1. Headed: removes the HeadlessChrome token (Linux without a display needs Xvfb installed)
agent-browser --headed open https://example.com

# 2. Headed plus no automation flag (--args splits on commas: one switch per entry)
agent-browser --headed --args "--disable-blink-features=AutomationControlled" open https://example.com

# 3. Persistent profile: cookies and history survive between runs
agent-browser --headed --profile ~/.agent-browser-profile open https://www.google.com

# 4. The user's own Chrome, started with a dedicated profile and signed in by hand
#    (ask the user to start it; recent Chrome ignores remote debugging on the default profile dir)
#    Linux:   google-chrome --remote-debugging-port=9222 --user-data-dir="$HOME/.agent-browser-chrome"
#    macOS:   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --remote-debugging-port=9222 --user-data-dir="$HOME/.agent-browser-chrome"
#    Windows: & "C:Program FilesGoogleChromeApplicationchrome.exe" --remote-debugging-port=9222 --user-data-dir="$env:USERPROFILE.agent-browser-chrome"
agent-browser --cdp 9222 open https://www.google.com
agent-browser --auto-connect open https://www.google.com

# 5. Different network: filters also score data center IP ranges
agent-browser --proxy "http://user:pass@proxy.example.com:8080" open https://example.com
```

Other options:

- `--user-agent "<desktop Chrome UA>"` hides the `HeadlessChrome` token while staying headless. Prefer `--headed` when a display is available, because client hints disappear.
- A `launch.mutate` plugin can add args, extensions, init scripts, and a user agent to every local launch. It does not run for `--cdp`, `--auto-connect`, or providers.
- Providers with stealth modes: `-p browserless` with `BROWSERLESS_STEALTH=true` (the default), or `-p kernel` with `KERNEL_STEALTH=true`.

## Check what the page sees

```bash
agent-browser eval "JSON.stringify({ ua: navigator.userAgent, webdriver: navigator.webdriver })"
agent-browser get title
```

A blocked page usually has a title such as "Access Denied", "Just a moment...", or a CAPTCHA prompt. Check the title after `open` before you snapshot or interact.
