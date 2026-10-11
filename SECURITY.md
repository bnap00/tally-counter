# Security

Tally is a static, local-first web application with no accounts or backend.
Counter state and preferences live in browser localStorage, which is not
encrypted. Other scripts served from the same origin can access that storage.
Use a dedicated HTTPS origin and do not use the counter for sensitive records.

## Reporting a vulnerability

Please use the repository's private vulnerability reporting feature under
**Security → Report a vulnerability**, when available. Otherwise, open an issue
requesting a private contact without including exploit details or sensitive data.
Do not publish credentials, personal browser data, or working exploits in issues.

The default branch is the supported version. Fixes are best-effort; this project
has no guaranteed response time or commercial support SLA.
