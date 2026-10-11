# Tally

A tiny, general-purpose, offline-first counter Progressive Web App.
Plain HTML, CSS, and JavaScript. No build step. No runtime dependencies.

## Features

- Endless, target, auto-reset, cycle, and countdown modes
- Adjustable targets and step size; default target of 100
- Subtract/restore, protected reset, keyboard controls, and session total
- Optional vibration, animation, and screen wake lock
- Light, Dark, System, and manual **Black (AMOLED)** themes
- Black uses pure-black backgrounds and never selects itself automatically
- Offline use after the initial online load and successful app-shell caching
- Local-only state and preferences, shared between tabs on the same origin

## Run

Serve this directory with Python 3 or any static HTTP server:

```sh
python3 -m http.server 8000
```

Open http://localhost:8000. Browser installation is optional. For remote hosting,
use HTTPS so service workers and supported device APIs can work. Upload the
production HTML, JavaScript, CSS, manifest, and `icons/` files to any static host;
no backend is required. To activate an app
update, close all open Tally tabs/windows and reopen it. The installed shell
stays on one version while an update waits.

## Controls

Tap/click the main counter, or use Space/Enter while focus is outside other
controls. Minus/Backspace subtracts one step (restores it in countdown). R opens
reset confirmation; Escape cancels it. Settings changes apply immediately.

## Test

Use Node.js 24 or newer:

```sh
node --test counter.test.js persistence.test.js shell.test.js theme.test.js keyboard.test.js
```

Tests cover mode transitions, malformed storage, cross-tab coordination,
accessibility-related shell checks, themes, icons, and service-worker behavior.
GitHub Actions runs these tests and JavaScript syntax checks on pushes and PRs.
See [release verification](docs/verification.md) for browser checks and limits.

## Privacy and compatibility

No analytics, accounts, third-party assets, or counter-data uploads. State is
stored in browser localStorage, not encrypted or backed up. Clearing site data
removes it; private browsing or blocked storage may prevent persistence. Hosting
providers may still log ordinary asset requests. Use a dedicated origin.

Use a modern browser with JavaScript modules and native dialogs. Installation,
vibration, wake lock, and Web Locks vary by browser/device. Counting works
without optional device APIs. Without Web Locks, simultaneous edits in multiple
tabs can conflict. Service-worker updates may need all app tabs closed/reopened.
The installed splash screen uses the manifest's fixed colors, not saved themes.

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).

## License

MIT. See [LICENSE](LICENSE).
