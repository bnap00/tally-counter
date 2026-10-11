# Tally PWA design

## Scope

Build a dependency-free, offline-first PWA. The app includes endless, target, auto-reset, target-of-targets, and countdown modes; protected reset; decrement or undo; local persistence; themes; optional vibration; wake lock; keyboard operation; reduced motion; installability; and offline use. Future features listed in the source requirements remain out of scope.

## Architecture

- `counter.js` owns defaults, state normalization, mode transitions, reset behavior, and derived progress. It has no browser dependencies.
- `app.js` loads and persists state, binds DOM events, renders the current state, coordinates vibration and wake lock, and registers the service worker.
- `index.html` contains semantic controls, the full-screen counter surface, an inline reset confirmation, and a settings dialog.
- `style.css` provides responsive themes, safe-area support, touch behavior, focus states, animation, and reduced-motion handling.
- `service-worker.js` caches only local static assets and removes old caches during activation.

There is no build step and no production dependency. Node's built-in test runner exercises the state engine.

## Interaction decisions

- A tap on the central surface advances the active mode by one logical step.
- Endless mode increments without a target.
- Target mode stops at its target.
- Auto-reset mode holds the completed target on screen. The next tap starts the next cycle at one.
- Target-of-targets increments the completed-cycle counter once when the primary target is reached. It holds the completed primary value until the next tap and stops when the secondary target completes.
- Countdown starts from the configured target and reaches zero. Its secondary action restores one step, while other modes subtract one.
- Reset uses an inline two-step confirmation instead of a hidden gesture or modal alert.
- Target changes preserve progress when possible and clamp only when the active mode cannot represent the old value.
- Keyboard shortcuts are Space or Enter to advance, minus or Backspace to undo, and R to open reset confirmation. Shortcuts do not fire from form controls.

## Presentation

The counter is a quiet numeric instrument rather than a generic dashboard. It uses system fonts, tabular numerals, a warm off-white light theme, and a near-black dark theme, and an explicitly selected pure-black AMOLED theme. A fine progress arc and small status labels add orientation without competing with the number. The settings control and secondary actions stay at the edges of the screen. The entire center remains the primary touch target.

The layout supports phone safe areas, portrait and landscape, coarse pointers, small screens, and installed PWA display. Completion is communicated with text, motion, color, and optional vibration rather than color alone.

## Persistence and resilience

State is versioned and normalized whenever it is read. Invalid JSON falls back to defaults. Updates render immediately and then write to `localStorage`. A visibility handler performs a final persistence write. Unsupported vibration, wake lock, service worker, or install APIs quietly fall back without affecting counting.

The state engine uses non-negative safe integers. User-entered targets and steps are clamped to valid safe integer ranges. Display formatting uses `Intl.NumberFormat` without abbreviating values.

## Offline and updates

The service worker precaches a versioned app shell. App navigation and static requests use the installed release cache first, keeping HTML and code coherent while a new worker waits. A missing navigation cache can use the network without overwriting the versioned shell. Activation removes older cache versions and claims clients. Updates activate after all tabs using the old worker close; reopening loads the new release.

## Verification

- Unit tests cover every mode, edge targets, nested completion, undo, reset, normalization, and large values.
- Browser checks cover pointer and keyboard counting, settings, reset confirmation, persistence, themes, responsive layouts, and console errors.
- Offline checks reload the app with networking disabled after an initial online load.
- A payload check reports compressed and uncompressed app-shell size, with reliability taking priority if the aspirational 14 KB compressed target is exceeded.

## Alternatives considered

An all-in-one HTML file would be smaller but would make state tests and maintenance worse. A framework would simplify component composition but violate the dependency and payload goals. The selected small-module design gives the counter logic a testable boundary while keeping the shipped code direct and compact.
