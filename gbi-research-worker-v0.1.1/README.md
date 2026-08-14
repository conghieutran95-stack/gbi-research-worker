# GBI Research Worker v0.1.1

Fixes:
- Pins Playwright package to 1.56.1 to match `mcr.microsoft.com/playwright:v1.56.1-noble`.
- Browser launch errors are caught and stored as failed job state instead of crashing the service.
- Health endpoint reports version 0.1.1.

Current milestone:
1 real seed -> 1 job -> browser attempt -> stable job status/result.
