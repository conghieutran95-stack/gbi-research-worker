import crypto from "node:crypto";
import express from "express";
import cors from "cors";
import { z } from "zod";
import { runGoogleAdsTransparency } from "./workers/google-transparency.js";
import type { DiscoveryJob } from "./types/discovery.js";

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const port = Number(process.env.PORT || 3000);
const apiKey = process.env.WORKER_API_KEY || "";
const ingestUrl = process.env.GBI_RESEARCH_INGEST_URL || "";
const ingestToken = process.env.SPY_ADS_INGEST_TOKEN || "";

const jobs = new Map<string, DiscoveryJob>();

function auth(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
) {
  if (!apiKey) return next();
  if (req.header("x-api-key") !== apiKey) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

function normalizeDomain(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  let raw = value.trim().toLowerCase();
  if (!raw) return undefined;

  try {
    if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
    const url = new URL(raw);
    return url.hostname.replace(/^www\./i, "") || undefined;
  } catch {
    return value
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//i, "")
      .replace(/^www\./i, "")
      .split("/")[0]
      .split("?")[0]
      .split("#")[0] || undefined;
  }
}

function parseSeedCursor(seed: string): {
  seedDomain: string;
  startOffset: number;
} {
  const match = seed.trim().match(/^(.*)::(\d+)$/);
  if (!match) return { seedDomain: seed.trim(), startOffset: 0 };

  return {
    seedDomain: match[1].trim(),
    startOffset: Math.max(0, Number(match[2]) || 0),
  };
}

function getRawPayload(result: any): any {
  return result?.raw_payload && typeof result.raw_payload === "object"
    ? result.raw_payload
    : {};
}

function buildIngestPayload(
  seed: string,
  country: string | undefined,
  workerOutput: any,
  startedAt?: string,
  finishedAt?: string
) {
  const { seedDomain, startOffset } = parseSeedCursor(seed);
  const results = Array.isArray(workerOutput?.results) ? workerOutput.results : [];

  const discoveries = results
    .map((result: any) => {
      const raw = getRawPayload(result);
      const domain = normalizeDomain(
        result?.domain ?? raw?.discovered_domain ?? raw?.domain
      );
      if (!domain) return null;

      const advertisers = Array.isArray(raw?.advertisers) ? raw.advertisers : [];
      const advertiser = advertisers[0] ?? {};

      return {
        provider: "google_ads_transparency",
        advertiser_id:
          raw?.advertiser_id ?? advertiser?.advertiser_id ?? undefined,
        advertiser_name:
          raw?.advertiser_name ?? advertiser?.advertiser_name ?? undefined,
        domain,
        landing_url: raw?.landing_url ?? result?.source_url ?? undefined,
        // Google Ads Transparency lifecycle timestamps.
        ads_first_seen:
          raw?.ads_first_seen ?? result?.first_seen ?? raw?.first_seen ?? undefined,
        ads_last_seen:
          raw?.ads_last_seen ?? result?.last_seen ?? raw?.last_seen ?? undefined,
        ads_age_days:
          raw?.ads_age_days ?? undefined,
        currently_active:
          raw?.currently_active ?? undefined,

        // Backward-compatible aliases expected by the current ingest endpoint.
        first_seen:
          raw?.ads_first_seen ?? result?.first_seen ?? raw?.first_seen ?? undefined,
        last_seen:
          raw?.ads_last_seen ?? result?.last_seen ?? raw?.last_seen ?? undefined,

        // Our own discovery/crawl timestamps are intentionally separate.
        discovered_at:
          raw?.crawler_discovered_at ?? result?.observed_at ?? finishedAt ?? new Date().toISOString(),
        last_crawled_at:
          raw?.crawler_last_checked_at ?? finishedAt ?? new Date().toISOString(),

        activity_status:
          result?.activity_status ?? raw?.activity_status ?? "UNKNOWN",
        search_creative_count:
          result?.creative_count ?? raw?.creative_count ?? 0,
        observed_at:
          result?.observed_at ?? finishedAt ?? new Date().toISOString(),
        source_ref: result?.source_ref ?? seedDomain,
      };
    })
    .filter(Boolean);

  const rawPayloads = results.map(getRawPayload);

  const nextCursor =
    rawPayloads.find((x: any) => x?.next_cursor)?.next_cursor ??
    workerOutput?.next_cursor ??
    undefined;

  const nextOffset =
    rawPayloads.find((x: any) => Number.isFinite(x?.next_offset))?.next_offset ??
    workerOutput?.next_offset ??
    undefined;

  const retryAfterSeconds =
    rawPayloads.find((x: any) => Number.isFinite(x?.retry_after_seconds))
      ?.retry_after_seconds ??
    workerOutput?.retry_after_seconds ??
    0;

  const http429Count =
    rawPayloads.find((x: any) => Number.isFinite(x?.rate_limit_retries))
      ?.rate_limit_retries ??
    rawPayloads.find((x: any) => Number.isFinite(x?.http_429_count))
      ?.http_429_count ??
    0;

  const captchaDetected = /captcha|human verification/i.test(
    String(workerOutput?.message || "")
  );

  return {
    seed_domain: seedDomain,
    country: country || "US",
    discoveries,
    checkpoint: {
      start_offset: startOffset,
      next_offset: nextOffset,
      next_cursor: nextCursor,
      status: workerOutput?.status || "UNKNOWN",
      retry_after_seconds: retryAfterSeconds,
      http_429_count: http429Count,
      captcha_detected: captchaDetected,
      started_at: startedAt,
      finished_at: finishedAt,
    },
  };
}

async function ingestSpyAds(
  seed: string,
  country: string | undefined,
  workerOutput: any,
  startedAt?: string,
  finishedAt?: string
): Promise<void> {
  if (!ingestUrl || !ingestToken) {
    console.warn(
      "[INGEST] SKIPPED: GBI_RESEARCH_INGEST_URL or SPY_ADS_INGEST_TOKEN missing"
    );
    return;
  }

  const payload = buildIngestPayload(
    seed,
    country,
    workerOutput,
    startedAt,
    finishedAt
  );

  console.log(
    `[INGEST] Sending ${payload.discoveries.length} discoveries to GBI RESEARCH...`
  );

  const response = await fetch(ingestUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${ingestToken}`,
    },
    body: JSON.stringify(payload),
  });

  const text = await response.text();

  if (!response.ok) {
    console.error(`[INGEST] HTTP ${response.status}: ${text.slice(0, 800)}`);
    return;
  }

  console.log(
    `[INGEST] HTTP ${response.status} SUCCESS: ${text.slice(0, 800)}`
  );
}

app.get("/health", (_req, res) =>
  res.json({
    ok: true,
    service: "gbi-research-worker",
    version: "0.1.3",
    ingest_configured: Boolean(ingestUrl && ingestToken),
    time: new Date().toISOString(),
  })
);

app.post("/jobs", auth, (req, res) => {
  const schema = z.object({
    type: z.literal("google_ads_transparency"),
    seed: z.string().min(2).max(500),
    country: z.string().min(2).max(20).optional(),
  });

  const parsed = schema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const id = crypto.randomUUID();

  const job: DiscoveryJob = {
    id,
    type: parsed.data.type,
    seed: parsed.data.seed,
    country: parsed.data.country,
    status: "queued",
    created_at: new Date().toISOString(),
    results: [],
  };

  jobs.set(id, job);
  res.status(202).json({ id, status: job.status });

  setImmediate(async () => {
    job.status = "running";
    job.started_at = new Date().toISOString();

    try {
      const out = await runGoogleAdsTransparency(job.seed, job.country);

      job.status = out.status;
      job.message = out.message;
      job.results = out.results;
      job.finished_at = new Date().toISOString();

      try {
        await ingestSpyAds(
          job.seed,
          job.country,
          out,
          job.started_at,
          job.finished_at
        );
      } catch (ingestError) {
        console.error(
          "[INGEST] UNHANDLED ERROR:",
          ingestError instanceof Error ? ingestError.message : ingestError
        );
      }
    } catch (e) {
      job.status = "failed";
      job.message =
        e instanceof Error ? e.message : "Unhandled worker error";
      job.finished_at = new Date().toISOString();

      try {
        await ingestSpyAds(
          job.seed,
          job.country,
          {
            status: "failed",
            message: job.message,
            results: job.results || [],
          },
          job.started_at,
          job.finished_at
        );
      } catch (ingestError) {
        console.error(
          "[INGEST] FAILED-JOB REPORT ERROR:",
          ingestError instanceof Error ? ingestError.message : ingestError
        );
      }
    } finally {
      if (!job.finished_at) job.finished_at = new Date().toISOString();
    }
  });
});

app.get("/jobs/:id", auth, (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found" });
  res.json(job);
});

app.get("/jobs", auth, (_req, res) =>
  res.json(
    [...jobs.values()].sort((a, b) =>
      b.created_at.localeCompare(a.created_at)
    )
  )
);

process.on("unhandledRejection", (reason) =>
  console.error("unhandledRejection", reason)
);

process.on("uncaughtException", (err) =>
  console.error("uncaughtException", err)
);

app.listen(port, "0.0.0.0", () =>
  console.log(
    `GBI Research Worker v0.1.3 listening on :${port} | ingest=${Boolean(
      ingestUrl && ingestToken
    )}`
  )
);
