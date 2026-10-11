# Release verification

Verified locally on 2026-10-12 (Asia/Kolkata), using Node.js 24.15.0.
These results describe the initial public-release candidate, not a guarantee
about future changes or every browser/device.

## Automated tests

```sh
node --test counter.test.js persistence.test.js shell.test.js theme.test.js keyboard.test.js
```

104 tests passed, zero failures. JavaScript syntax checks and Git whitespace
checks passed. Coverage includes all five counting modes, safe integers, target
changes, malformed persisted state, cross-tab coordination, settings, themes,
icons, offline navigation, and cache cleanup.

## Browser verification

Playwright tested Chromium 156.0.8078.4 and WebKit 27.2:

- Pointer increment/subtract, keyboard increment, and protected reset
- Target, auto-reset, cycle, and countdown completion transitions
- Manual Black theme with pure-black page and settings backgrounds
- Black preference survives reload and OS light/dark changes
- Main/settings layouts at 280px, 320px, phone landscape, and desktop widths
- Offline reload and counting after service-worker activation
- No observed page errors or third-party requests
- axe WCAG A/AA scans: zero detected violations on main/settings in all themes

A real Chromium upgrade test kept old HTML and JavaScript together while a new
worker waited, then loaded both new assets after all old tabs closed. Modifier
and composition-key regression tests confirm browser commands are not intercepted.

Additional Chromium tests retained all 20 simultaneous increments across two
tabs, synchronized Black theme, and recovered from malformed localStorage.
Browser QA dependencies were installed outside the project; they are not runtime
dependencies. Automated accessibility tools do not prove full compliance.

## Packaging checks

Project text, documentation, and hidden local metadata were reviewed. Neutral
tally icons were inspected visually. No credential patterns were detected by
the release sweep. Deployment metadata is excluded from Git. The MIT license,
README, contributing guide, security policy, and CI workflow are included.

The app-shell payload including all icon variants measured 89,699 raw bytes and
41,489 bytes summing each file's gzip-compressed size. This is not the same as
an actual browser transfer measurement. It exceeds the original aspirational
14 KB compressed budget; functionality and accessibility were not cut to meet it.

## Not tested on physical devices

Real iOS/Android installation, physical vibration, wake lock, native select
rendering, and AMOLED power consumption still require device testing. The
installed splash screen has fixed manifest colors. Browser API availability
varies. Without Web Locks, simultaneous tab edits may conflict. Local storage is
not encrypted and is lost when site data is cleared.
