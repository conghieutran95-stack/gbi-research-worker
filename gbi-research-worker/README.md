# GBI Research Worker V1

Backend browser worker for **GBI RESEARCH — Project Discovery & Intelligence**.

## Scope
- `GET /health`
- `POST /jobs`
- `GET /jobs/:id`
- Google Ads Transparency browser discovery
- Returns normalized results for preview in GBI RESEARCH
- Does not write directly to `discovered_projects` in V1
- Does not bypass CAPTCHA, authentication, rate limits, or access controls
- Returns `manual_required` / `blocked` when provider automation is unavailable

## Local run
```bash
cp .env.example .env
npm install
npx playwright install --with-deps chromium
npm start
```

Health:
```bash
curl http://localhost:3000/health
```

Create job:
```bash
curl -X POST http://localhost:3000/jobs \
  -H "Content-Type: application/json" \
  -H "x-api-key: change-me" \
  -d '{"type":"google_ads_transparency","seed":"comfrt.com","country":"US"}'
```

Then poll:
```bash
curl -H "x-api-key: change-me" http://localhost:3000/jobs/JOB_ID
```

## Railway
1. Push this folder to a GitHub repo named `gbi-research-worker`.
2. Create a Railway project from that repo.
3. Add env vars:
   - `WORKER_API_KEY`
   - `PLAYWRIGHT_HEADLESS=true`
4. Railway builds from the Dockerfile.
5. Generate a public domain.
6. Test `/health`.

## GBI RESEARCH integration
Lovable calls:
- `POST https://<worker>/jobs`
- `GET https://<worker>/jobs/:id`

Only after preview + explicit confirmation should the app write to:
- `discovered_projects`
- `discovery_sources` with `source_type = spy_ads`

## Definition of Done
**1 real seed → 1 job → real public result → normalized domain → preview in GBI RESEARCH.**
