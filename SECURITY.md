# Security

Tally is a static, local-first web application with no accounts or backend.
Counter state and preferences live in browser localStorage, which is not
encrypted. Other scripts served from the same origin can access that storage.
Use a dedicated HTTPS origin and do not use the counter for sensitive records.

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's private vulnerability
reporting: [Security → Report a vulnerability](https://github.com/bnap00/tally-counter/security/advisories/new).
Do not open a public issue for security problems.
Do not publish credentials, personal browser data, or working exploits in issues.

The default branch is the supported version. Fixes are best-effort; this project
has no guaranteed response time or commercial support SLA.
