# Contributing to Tally

Small, focused contributions are welcome. Keep Tally a general-purpose counter:
no accounts, tracking, backend, or runtime dependencies.

## Local development

Use Node.js 24 or newer for tests and Python 3 (or any static HTTP server) to
serve the app:

```sh
node --test counter.test.js persistence.test.js shell.test.js theme.test.js keyboard.test.js
python3 -m http.server 8000
```

Open http://localhost:8000. Service workers require localhost or HTTPS.

## Pull requests

1. Open an issue for substantial changes before implementing them.
2. Add a failing regression test, implement the smallest fix, and run all tests.
3. Check counting, settings, keyboard controls, persistence, and offline reload.
4. Check small phone and landscape layouts, all themes, and reduced motion.
5. Bump the service-worker cache version when app-shell assets change.
6. Describe the change and the checks you actually ran in the pull request.

Use accessible native controls, local assets, and plain JavaScript modules.
Do not commit credentials, deployment account metadata, or personal data.

## Reporting issues

Include browser/version, device size, reproduction steps, expected behavior,
and actual behavior. Do not attach sensitive browser storage contents.

## Conduct

Be respectful, assume good intent, and keep feedback focused on the work.
Harassment and sharing another person's private information are not acceptable.
