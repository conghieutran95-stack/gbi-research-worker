import crypto from "node:crypto";
import express from "express";
import cors from "cors";
import { z } from "zod";

import { runGoogleAdsTransparency } from "./workers/google-transparency.js";
import {
  resolveDomainFromImage,
  resolveDomainsFromImages,
} from "./workers/image-domain-resolver.js";
import { parseTransparencyCsv } from "./workers/csv-importer.js";

import type { DiscoveryJob } from "./types/discovery.js";

const app = express();

app.use(cors());
app.use(express.json({ limit: "10mb" }));

const port = Number(process.env.PORT || 3000);
const apiKey = process.env.WORKER_API_KEY || "";
const ingestUrl = process.env.GBI_RESEARCH_INGEST_URL || "";
const ingestToken = process.env.SPY_ADS_INGEST_TOKEN || "";
function normalizeSupabaseBaseUrl(value: string): string {
  return value
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/rest\/v1$/i, "")
    .replace(/\/+$/, "");
}

const supabaseUrl = normalizeSupabaseBaseUrl(
  process.env.SUPABASE_URL || ""
);
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

const jobs = new Map<string, DiscoveryJob>();

type QueueRunNodeResult = {
  queue_id: string;
  node_type: string;
  node_key: string;
  depth: number;
  status: "done" | "failed" | "skip" | "retry";
  discovered_domains: number;
  result_count: number;
  next_cursor?: string;
  message?: string;
};

type QueueRun = {
  id: string;
  status: "queued" | "running" | "completed" | "failed";
  created_at: string;
  started_at?: string;
  finished_at?: string;
  country: string;
  requested_limit: number;
  max_depth: number;
  claimed_nodes: number;
  processed_nodes: number;
  discovered_domains: number;
  results: QueueRunNodeResult[];
  message?: string;
};

const queueRuns = new Map<string, QueueRun>();

/* =========================================================
   AUTH
========================================================= */

function auth(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
) {
  if (!apiKey) return next();

  if (req.header("x-api-key") !== apiKey) {
    return res.status(401).json({
      error: "Unauthorized",
    });
  }

  next();
}

/* =========================================================
   HELPERS
========================================================= */

function normalizeDomain(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;

  let raw = value.trim().toLowerCase();

  if (!raw) return undefined;

  try {
    if (!/^https?:\/\//i.test(raw)) {
      raw = `https://${raw}`;
    }

    const url = new URL(raw);

    return (
      url.hostname.replace(/^www\./i, "") ||
      undefined
    );
  } catch {
    return (
      value
        .trim()
        .toLowerCase()
        .replace(/^https?:\/\//i, "")
        .replace(/^www\./i, "")
        .split("/")[0]
        .split("?")[0]
        .split("#")[0] || undefined
    );
  }
}

function parseSeedCursor(seed: string): {
  seedDomain: string;
  startOffset: number;
} {
  const match = seed
    .trim()
    .match(/^(.*)::(\d+)$/);

  if (!match) {
    return {
      seedDomain: seed.trim(),
      startOffset: 0,
    };
  }

  return {
    seedDomain: match[1].trim(),
    startOffset: Math.max(
      0,
      Number(match[2]) || 0
    ),
  };
}

function getRawPayload(result: any): any {
  return result?.raw_payload &&
    typeof result.raw_payload === "object"
    ? result.raw_payload
    : {};
}


/* =========================================================
   LOW-LOG CRAWLER WRAPPER
========================================================= */

const crawlerLogMode =
  (process.env.CRAWLER_LOG_MODE || "compact")
    .trim()
    .toLowerCase();


const autoQueueEnabled =
  (process.env.AUTO_QUEUE_ENABLED || "false")
    .trim()
    .toLowerCase() === "true";

const autoQueueIntervalMs = Math.max(
  60_000,
  Number(process.env.AUTO_QUEUE_INTERVAL_MS || 300_000)
);

const autoQueueCountry =
  (process.env.AUTO_QUEUE_COUNTRY || "US")
    .trim() || "US";

const autoQueueMaxDepth = Math.max(
  0,
  Math.min(
    3,
    Number(process.env.AUTO_QUEUE_MAX_DEPTH || 3)
  )
);

const autoQueueLimit = 1;

const crawlTimeoutMs = Math.max(
  60_000,
  Number(process.env.CRAWL_TIMEOUT_MS || 240_000)
);

let autoQueueBusy = false;
let autoQueueTimer: NodeJS.Timeout | undefined;

async function runGoogleAdsTransparencyCompact(
  seed: string,
  country?: string
): Promise<any> {
  if (crawlerLogMode === "verbose") {
    return runGoogleAdsTransparency(seed, country);
  }

  const originalLog = console.log;
  const originalInfo = console.info;
  const originalDebug = console.debug;
  const started = Date.now();

  originalLog(
    `[CRAWL] START seed=${seed} country=${country || "US"}`
  );

  console.log = () => undefined;
  console.info = () => undefined;
  console.debug = () => undefined;

  try {
    const out = await Promise.race([
      runGoogleAdsTransparency(seed, country),
      new Promise((_, reject) => {
        const timer = setTimeout(
          () => reject(
            new Error(
              `CRAWL_TIMEOUT after ${crawlTimeoutMs}ms for seed=${seed}`
            )
          ),
          crawlTimeoutMs
        );

        (timer as any).unref?.();
      }),
    ]);

    const results =
      Array.isArray((out as any)?.results)
        ? (out as any).results
        : [];

    const uniqueDomains =
      new Set(
        results
          .map((item: any) =>
            normalizeDomain(
              item?.domain ??
                getRawPayload(item)?.discovered_domain ??
                getRawPayload(item)?.domain
            )
          )
          .filter(Boolean)
      ).size;

    const nextCursor =
      typeof (out as any)?.next_cursor === "string"
        ? (out as any).next_cursor
        : undefined;

    originalLog(
      [
        "[CRAWL] DONE",
        `seed=${seed}`,
        `status=${String((out as any)?.status || "unknown")}`,
        `results=${results.length}`,
        `unique_domains=${uniqueDomains}`,
        `next_cursor=${nextCursor || "none"}`,
        `duration_ms=${Date.now() - started}`,
      ].join(" ")
    );

    return out as any;
  } catch (error) {
    console.error(
      `[CRAWL] ERROR seed=${seed} error=${
        error instanceof Error
          ? error.message
          : String(error)
      }`
    );
    throw error;
  } finally {
    console.log = originalLog;
    console.info = originalInfo;
    console.debug = originalDebug;
  }
}

/* =========================================================
   INGEST PAYLOAD
========================================================= */

function buildIngestPayload(
  seed: string,
  country: string | undefined,
  workerOutput: any,
  startedAt?: string,
  finishedAt?: string
) {
  const {
    seedDomain,
    startOffset,
  } = parseSeedCursor(seed);

  const results = Array.isArray(
    workerOutput?.results
  )
    ? workerOutput.results
    : [];

  const discoveries = results
    .map((result: any) => {
      const raw = getRawPayload(result);

      const domain = normalizeDomain(
        result?.domain ??
          raw?.discovered_domain ??
          raw?.domain
      );

      if (!domain) return null;

      const advertisers = Array.isArray(
        raw?.advertisers
      )
        ? raw.advertisers
        : [];

      const advertiser =
        advertisers[0] ?? {};

      return {
        provider:
          "google_ads_transparency",

        advertiser_id:
          raw?.advertiser_id ??
          advertiser?.advertiser_id ??
          undefined,

        advertiser_name:
          raw?.advertiser_name ??
          advertiser?.advertiser_name ??
          undefined,

        domain,

        landing_url:
          raw?.landing_url ??
          result?.source_url ??
          undefined,

        /* Google Ads lifecycle */
        ads_first_seen:
          raw?.ads_first_seen ??
          result?.first_seen ??
          raw?.first_seen ??
          undefined,

        ads_last_seen:
          raw?.ads_last_seen ??
          result?.last_seen ??
          raw?.last_seen ??
          undefined,

        ads_age_days:
          raw?.ads_age_days ??
          undefined,

        currently_active:
          raw?.currently_active ??
          undefined,

        /* Backward compatible fields */
        first_seen:
          raw?.ads_first_seen ??
          result?.first_seen ??
          raw?.first_seen ??
          undefined,

        last_seen:
          raw?.ads_last_seen ??
          result?.last_seen ??
          raw?.last_seen ??
          undefined,

        /* Crawl timestamps */
        discovered_at:
          raw?.crawler_discovered_at ??
          result?.observed_at ??
          finishedAt ??
          new Date().toISOString(),

        last_crawled_at:
          raw?.crawler_last_checked_at ??
          finishedAt ??
          new Date().toISOString(),

        activity_status:
          result?.activity_status ??
          raw?.activity_status ??
          "UNKNOWN",

        search_creative_count:
          result?.creative_count ??
          raw?.creative_count ??
          0,

        observed_at:
          result?.observed_at ??
          finishedAt ??
          new Date().toISOString(),

        source_ref:
          result?.source_ref ??
          seedDomain,
      };
    })
    .filter(Boolean);

  const rawPayloads =
    results.map(getRawPayload);

  const nextCursor =
    rawPayloads.find(
      (x: any) => x?.next_cursor
    )?.next_cursor ??
    workerOutput?.next_cursor ??
    undefined;

  const nextOffset =
    rawPayloads.find(
      (x: any) =>
        Number.isFinite(x?.next_offset)
    )?.next_offset ??
    workerOutput?.next_offset ??
    undefined;

  const retryAfterSeconds =
    rawPayloads.find(
      (x: any) =>
        Number.isFinite(
          x?.retry_after_seconds
        )
    )?.retry_after_seconds ??
    workerOutput?.retry_after_seconds ??
    0;

  const http429Count =
    rawPayloads.find(
      (x: any) =>
        Number.isFinite(
          x?.rate_limit_retries
        )
    )?.rate_limit_retries ??
    rawPayloads.find(
      (x: any) =>
        Number.isFinite(
          x?.http_429_count
        )
    )?.http_429_count ??
    0;

  const captchaDetected =
    /captcha|human verification/i.test(
      String(
        workerOutput?.message || ""
      )
    );

  return {
    seed_domain: seedDomain,
    country: country || "US",

    discoveries,

    checkpoint: {
      start_offset: startOffset,
      next_offset: nextOffset,
      next_cursor: nextCursor,

      status:
        workerOutput?.status ||
        "UNKNOWN",

      retry_after_seconds:
        retryAfterSeconds,

      http_429_count:
        http429Count,

      captcha_detected:
        captchaDetected,

      started_at: startedAt,
      finished_at: finishedAt,
    },
  };
}

/* =========================================================
   INGEST
========================================================= */

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

  const payload =
    buildIngestPayload(
      seed,
      country,
      workerOutput,
      startedAt,
      finishedAt
    );

  console.log(
    `[INGEST] Sending ${payload.discoveries.length} discoveries to GBI RESEARCH...`
  );

  const response = await fetch(
    ingestUrl,
    {
      method: "POST",

      headers: {
        "content-type":
          "application/json",

        authorization:
          `Bearer ${ingestToken}`,
      },

      body:
        JSON.stringify(payload),
    }
  );

  const text =
    await response.text();

  if (!response.ok) {
    console.error(
      `[INGEST] HTTP ${response.status}: ${text.slice(
        0,
        800
      )}`
    );

    return;
  }

  console.log(
    `[INGEST] HTTP ${response.status} SUCCESS: ${text.slice(
      0,
      800
    )}`
  );
}

/* =========================================================
   SUPABASE RPC
========================================================= */

async function ingestDomainCsvToSupabase(
  seed: string,
  rows: unknown[]
): Promise<any> {
  if (!supabaseUrl || !supabaseServiceRoleKey) {
    throw new Error(
      "SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is missing"
    );
  }

  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
    apikey: supabaseServiceRoleKey,
  };

  // Legacy service_role keys are JWTs and may also be used as Bearer tokens.
  // New sb_secret_* keys should be sent on the apikey header.
  if (supabaseServiceRoleKey.startsWith("eyJ")) {
    headers.authorization = `Bearer ${supabaseServiceRoleKey}`;
  }

  const rpcUrl =
    `${supabaseUrl}/rest/v1/rpc/spy_ingest_domain_csv`;

  console.log(
    `[SUPABASE] RPC ${rpcUrl}`
  );

  const response = await fetch(
    rpcUrl,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        p_seed: seed,
        p_rows: rows,
        p_source: "transparency_csv",
      }),
      signal: AbortSignal.timeout(30_000),
    }
  );

  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `Supabase RPC HTTP ${response.status}: ${text.slice(0, 1200)}`
    );
  }

  if (!text.trim()) {
    return { ok: true };
  }

  try {
    return JSON.parse(text);
  } catch {
    return { ok: true, raw: text };
  }
}


async function ingestAdvertiserOcrToSupabase(
  seedAdvertiser: string,
  rows: unknown[]
): Promise<any> {
  if (!supabaseUrl || !supabaseServiceRoleKey) {
    throw new Error(
      "SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is missing"
    );
  }

  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
    apikey: supabaseServiceRoleKey,
  };

  if (supabaseServiceRoleKey.startsWith("eyJ")) {
    headers.authorization = `Bearer ${supabaseServiceRoleKey}`;
  }

  const rpcUrl =
    `${supabaseUrl}/rest/v1/rpc/spy_ingest_advertiser_ocr`;

  console.log(
    `[SUPABASE] OCR RPC ${rpcUrl} | rows=${rows.length}`
  );

  const response = await fetch(
    rpcUrl,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        p_seed_advertiser: seedAdvertiser,
        p_rows: rows,
        p_source: "transparency_csv_ocr",
      }),
      signal: AbortSignal.timeout(60_000),
    }
  );

  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `Supabase OCR RPC HTTP ${response.status}: ${text.slice(0, 1200)}`
    );
  }

  if (!text.trim()) {
    return { ok: true };
  }

  try {
    return JSON.parse(text);
  } catch {
    return {
      ok: true,
      raw: text,
    };
  }
}

function buildAdvertiserOcrRows(
  importedRows: any[],
  resolutionResults: any[]
): any[] {
  const resolutionByImage = new Map<string, any>();

  for (const result of resolutionResults) {
    const imageUrl =
      typeof result?.imageUrl === "string"
        ? result.imageUrl.trim()
        : "";

    if (imageUrl) {
      resolutionByImage.set(imageUrl, result);
    }
  }

  return importedRows.map((row: any) => {
    const imageUrl =
      typeof row?.imageUrl === "string"
        ? row.imageUrl.trim()
        : "";

    const resolution =
      imageUrl
        ? resolutionByImage.get(imageUrl)
        : undefined;

    const resolvedDomain =
      normalizeDomain(
        resolution?.primaryDomain ??
        resolution?.domain ??
        (Array.isArray(resolution?.domains)
          ? resolution.domains[0]
          : undefined)
      );

    return {
      ...row,
      resolvedDomain,
      ocrText:
        resolution?.ocrText ??
        undefined,
      confidence:
        typeof resolution?.confidence === "number"
          ? resolution.confidence
          : undefined,
    };
  });
}


type ClaimedQueueNode = {
  id: string;
  node_type: string;
  node_key: string;
  depth: number;
  priority: number;
  parent_type?: string | null;
  parent_key?: string | null;
};

function supabaseHeaders(): Record<string, string> {
  if (!supabaseServiceRoleKey) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY is missing");
  }

  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
    apikey: supabaseServiceRoleKey,
  };

  if (supabaseServiceRoleKey.startsWith("eyJ")) {
    headers.authorization = `Bearer ${supabaseServiceRoleKey}`;
  }

  return headers;
}

async function callSupabaseRpc(
  functionName: string,
  payload: Record<string, unknown>,
  timeoutMs = 30_000
): Promise<any> {
  if (!supabaseUrl) {
    throw new Error("SUPABASE_URL is missing");
  }

  const rpcUrl =
    `${supabaseUrl}/rest/v1/rpc/${functionName}`;

  console.log(`[SUPABASE] RPC ${functionName}`);

  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: supabaseHeaders(),
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `Supabase RPC ${functionName} HTTP ${response.status}: ${text.slice(0, 1200)}`
    );
  }

  if (!text.trim()) return null;

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function claimDomainQueueNodes(
  limit: number,
  maxDepth: number
): Promise<ClaimedQueueNode[]> {
  const data = await callSupabaseRpc(
    "spy_claim_domain_expansion_queue",
    {
      p_limit: limit,
      p_max_depth: maxDepth,
    }
  );

  return Array.isArray(data)
    ? data.map((item: any) => ({
        id: String(item.id),
        node_type: String(item.node_type),
        node_key: String(item.node_key),
        depth: Number(item.depth || 0),
        priority: Number(item.priority || 0),
        parent_type:
          item.parent_type == null
            ? null
            : String(item.parent_type),
        parent_key:
          item.parent_key == null
            ? null
            : String(item.parent_key),
      }))
    : [];
}

async function finishDomainQueueNodeProtected(
  id: string,
  status: "done" | "failed" | "skip" | "blocked",
  error?: string,
  retryAfterSeconds?: number,
  cooldownSeconds = 86_400,
  maxAttempts = 4
): Promise<void> {
  await callSupabaseRpc(
    "spy_finish_expansion_queue_v2",
    {
      p_id: id,
      p_status: status,
      p_error: error ?? null,
      p_retry_after_seconds:
        Number.isFinite(retryAfterSeconds)
          ? Math.max(30, Number(retryAfterSeconds))
          : null,
      p_cooldown_seconds: cooldownSeconds,
      p_max_attempts: maxAttempts,
    }
  );
}

function extractQueueRateLimitInfo(
  workerOutput: any
): {
  http429Count: number;
  retryAfterSeconds: number;
} {
  const rawPayloads = Array.isArray(workerOutput?.results)
    ? workerOutput.results.map(getRawPayload)
    : [];

  const numeric = (value: unknown): number | undefined => {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  };

  let http429Count =
    numeric(workerOutput?.http_429_count) ??
    numeric(workerOutput?.rate_limit_retries) ??
    0;

  let retryAfterSeconds =
    numeric(workerOutput?.retry_after_seconds) ??
    0;

  for (const raw of rawPayloads) {
    http429Count = Math.max(
      http429Count,
      numeric(raw?.http_429_count) ?? 0,
      numeric(raw?.rate_limit_retries) ?? 0
    );

    retryAfterSeconds = Math.max(
      retryAfterSeconds,
      numeric(raw?.retry_after_seconds) ?? 0
    );
  }

  const message = String(workerOutput?.message || "");

  if (/429|rate.?limit/i.test(message) && http429Count === 0) {
    http429Count = 1;
  }

  if (http429Count > 0 && retryAfterSeconds <= 0) {
    retryAfterSeconds = 60;
  }

  return {
    http429Count,
    retryAfterSeconds,
  };
}

function extractNextCursor(
  workerOutput: any
): string | undefined {
  if (
    typeof workerOutput?.next_cursor === "string" &&
    workerOutput.next_cursor.trim()
  ) {
    return workerOutput.next_cursor.trim();
  }

  const results = Array.isArray(workerOutput?.results)
    ? workerOutput.results
    : [];

  for (const result of results) {
    const raw = getRawPayload(result);

    if (
      typeof raw?.next_cursor === "string" &&
      raw.next_cursor.trim()
    ) {
      return raw.next_cursor.trim();
    }
  }

  return undefined;
}

function buildQueueDiscoveryRows(
  workerOutput: any
): Array<Record<string, unknown>> {
  const results = Array.isArray(workerOutput?.results)
    ? workerOutput.results
    : [];

  const rows: Array<Record<string, unknown>> = [];

  for (const result of results) {
    const raw = getRawPayload(result);

    const domain = normalizeDomain(
      result?.domain ??
        raw?.discovered_domain ??
        raw?.domain
    );

    if (!domain) continue;

    const advertisers = Array.isArray(raw?.advertisers)
      ? raw.advertisers
      : [];

    const advertiserIds = Array.isArray(raw?.advertiser_ids)
      ? raw.advertiser_ids
      : [];

    const candidates: Array<{
      advertiser_id?: string;
      advertiser_name?: string;
    }> = [];

    for (const advertiser of advertisers) {
      candidates.push({
        advertiser_id:
          typeof advertiser?.advertiser_id === "string"
            ? advertiser.advertiser_id
            : undefined,
        advertiser_name:
          typeof advertiser?.advertiser_name === "string"
            ? advertiser.advertiser_name
            : undefined,
      });
    }

    if (candidates.length === 0) {
      const fallbackId =
        typeof raw?.advertiser_id === "string"
          ? raw.advertiser_id
          : typeof advertiserIds[0] === "string"
            ? advertiserIds[0]
            : undefined;

      candidates.push({
        advertiser_id: fallbackId,
        advertiser_name:
          typeof raw?.advertiser_name === "string"
            ? raw.advertiser_name
            : undefined,
      });
    }

    for (const advertiser of candidates) {
      if (!advertiser.advertiser_id) continue;

      rows.push({
        domain,
        advertiser_id: advertiser.advertiser_id,
        advertiser_name: advertiser.advertiser_name,
        first_seen:
          raw?.ads_first_seen ??
          raw?.first_seen ??
          result?.first_seen ??
          undefined,
        last_seen:
          raw?.ads_last_seen ??
          raw?.last_seen ??
          result?.last_seen ??
          undefined,
        creative_count:
          raw?.creative_count ??
          result?.creative_count ??
          1,
        confidence:
          raw?.confidence ??
          result?.confidence ??
          undefined,
      });
    }
  }

  return rows;
}

async function ingestQueueDomainWorkerResults(
  node: ClaimedQueueNode,
  workerOutput: any
): Promise<any> {
  const rows = buildQueueDiscoveryRows(workerOutput);
  const nextCursor = extractNextCursor(workerOutput);

  return callSupabaseRpc(
    "spy_ingest_queue_domain_results",
    {
      p_queue_id: node.id,
      p_seed: node.node_key,
      p_depth: node.depth,
      p_results: rows,
      p_next_cursor: nextCursor ?? null,
    },
    60_000
  );
}

async function processQueueRun(
  run: QueueRun
): Promise<void> {
  run.status = "running";
  run.started_at = new Date().toISOString();

  try {
    const nodes = await claimDomainQueueNodes(
      run.requested_limit,
      run.max_depth
    );

    run.claimed_nodes = nodes.length;

    if (nodes.length === 0) {
      run.status = "completed";
      run.message =
        "No pending domain/domain_cursor nodes available within max_depth.";
      return;
    }

    for (const node of nodes) {
      try {
        console.log(
          `[QUEUE] Processing ${node.node_type}:${node.node_key} depth=${node.depth}`
        );

        const out = await runGoogleAdsTransparencyCompact(
          node.node_key,
          run.country
        );

        const rows = buildQueueDiscoveryRows(out);
        const uniqueDomains = new Set(
          rows
            .map((row) => normalizeDomain(row.domain))
            .filter(Boolean)
        );

        const nextCursor = extractNextCursor(out);

        await ingestQueueDomainWorkerResults(
          node,
          out
        );

        const workerStatus =
          String(out?.status || "").toLowerCase();

        const {
          http429Count,
          retryAfterSeconds,
        } = extractQueueRateLimitInfo(out);

        const resultCount =
          Array.isArray(out?.results)
            ? out.results.length
            : 0;

        /*
         * A 429 seen during a crawl does NOT automatically mean
         * the whole node failed. The crawler may back off/retry
         * internally and still return status=completed with useful
         * results. In that case we keep the ingested results and
         * mark the node done.
         *
         * Retry only when the worker explicitly reports a
         * rate-limited/retry state, or when 429 occurred and the
         * crawl produced no usable results.
         */
        const shouldRetry =
          workerStatus === "rate_limited" ||
          workerStatus === "retry" ||
          (
            http429Count > 0 &&
            resultCount === 0 &&
            workerStatus !== "completed"
          );

        if (shouldRetry) {
          const retryMessage =
            `Rate limited/incomplete: http429=${http429Count}; results=${resultCount}; retry_after=${retryAfterSeconds}s`;

          await finishDomainQueueNodeProtected(
            node.id,
            "failed",
            retryMessage,
            retryAfterSeconds,
            86_400,
            4
          );

          console.log(
            `[QUEUE] RETRY node=${node.node_key} http429=${http429Count} results=${resultCount} retry_after=${retryAfterSeconds}s`
          );

          run.processed_nodes += 1;

          run.results.push({
            queue_id: node.id,
            node_type: node.node_type,
            node_key: node.node_key,
            depth: node.depth,
            status: "retry",
            discovered_domains: 0,
            result_count: resultCount,
            next_cursor: nextCursor,
            message: retryMessage,
          });

          continue;
        }

        if (http429Count > 0 && workerStatus === "completed") {
          console.log(
            `[QUEUE] 429_RECOVERED node=${node.node_key} http429=${http429Count} results=${resultCount} domains=${uniqueDomains.size}`
          );
        }

        const finalStatus:
          | "done"
          | "failed"
          | "skip" =
          workerStatus === "failed"
            ? "failed"
            : "done";

        if (finalStatus === "done") {
          await finishDomainQueueNodeProtected(
            node.id,
            "done",
            undefined,
            undefined,
            86_400,
            4
          );
        } else {
          const workerMessage =
            typeof out?.message === "string"
              ? out.message
              : `Worker status=${workerStatus || "failed"}`;

          await finishDomainQueueNodeProtected(
            node.id,
            "failed",
            workerMessage,
            undefined,
            86_400,
            4
          );
        }

        run.processed_nodes += 1;
        run.discovered_domains +=
          finalStatus === "done"
            ? uniqueDomains.size
            : 0;

        run.results.push({
          queue_id: node.id,
          node_type: node.node_type,
          node_key: node.node_key,
          depth: node.depth,
          status: finalStatus,
          discovered_domains:
            finalStatus === "done"
              ? uniqueDomains.size
              : 0,
          result_count:
            Array.isArray(out?.results)
              ? out.results.length
              : 0,
          next_cursor: nextCursor,
          message:
            typeof out?.message === "string"
              ? out.message
              : undefined,
        });
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : String(error);

        console.error(
          `[QUEUE] FAILED node=${node.node_type}:${node.node_key} error=${message}`
        );

        try {
          await finishDomainQueueNodeProtected(
            node.id,
            "failed",
            message,
            undefined,
            86_400,
            4
          );
        } catch (finishError) {
          console.error(
            `[QUEUE] FAILED_TO_MARK queue_id=${node.id} error=${
              finishError instanceof Error
                ? finishError.message
                : String(finishError)
            }`
          );
        }

        run.processed_nodes += 1;
        run.results.push({
          queue_id: node.id,
          node_type: node.node_type,
          node_key: node.node_key,
          depth: node.depth,
          status: "failed",
          discovered_domains: 0,
          result_count: 0,
          message,
        });
      }
    }

    run.status = "completed";
  } catch (error) {
    run.status = "failed";
    run.message =
      error instanceof Error
        ? error.message
        : String(error);
  } finally {
    run.finished_at =
      new Date().toISOString();
  }
}

/* =========================================================
   HEALTH
========================================================= */

app.get("/health", (_req, res) => {
  return res.json({
    ok: true,

    service:
      "gbi-research-worker",

    version:
      "0.2.4",

    ingest_configured:
      Boolean(
        ingestUrl &&
          ingestToken
      ),

    image_domain_resolver:
      true,

    csv_importer:
      true,

    queue_runner:
      true,

    queue_runner_mode:
      "domain_only_v1",

    crawler_log_mode:
      crawlerLogMode,

    compact_crawler_logs:
      crawlerLogMode !== "verbose",

    auto_queue_enabled:
      autoQueueEnabled,

    auto_queue_interval_ms:
      autoQueueIntervalMs,

    auto_queue_limit:
      autoQueueLimit,

    auto_queue_max_depth:
      autoQueueMaxDepth,

    auto_queue_country:
      autoQueueCountry,

    auto_queue_busy:
      autoQueueBusy,

    queue_protection:
      true,

    queue_cooldown_seconds:
      86400,

    queue_max_attempts:
      4,

    crawl_timeout_ms:
      crawlTimeoutMs,

    supabase_configured:
      Boolean(
        supabaseUrl &&
          supabaseServiceRoleKey
      ),

    supabase_base_url:
      supabaseUrl || null,

    time:
      new Date().toISOString(),
  });
});

/* =========================================================
   GOOGLE ADS TRANSPARENCY JOB
========================================================= */

app.post(
  "/jobs",
  auth,
  (req, res) => {
    const schema = z.object({
      type: z.literal(
        "google_ads_transparency"
      ),

      seed: z
        .string()
        .min(2)
        .max(500),

      country: z
        .string()
        .min(2)
        .max(20)
        .optional(),
    });

    const parsed =
      schema.safeParse(req.body);

    if (!parsed.success) {
      return res.status(400).json({
        error:
          parsed.error.flatten(),
      });
    }

    const id =
      crypto.randomUUID();

    const job: DiscoveryJob = {
      id,

      type:
        parsed.data.type,

      seed:
        parsed.data.seed,

      country:
        parsed.data.country,

      status:
        "queued",

      created_at:
        new Date().toISOString(),

      results: [],
    };

    jobs.set(id, job);

    res.status(202).json({
      id,
      status: job.status,
    });

    setImmediate(async () => {
      job.status =
        "running";

      job.started_at =
        new Date().toISOString();

      try {
        const out =
          await runGoogleAdsTransparencyCompact(
            job.seed,
            job.country
          );

        job.status =
          out.status;

        job.message =
          out.message;

        job.results =
          out.results;

        job.finished_at =
          new Date().toISOString();

        try {
          await ingestSpyAds(
            job.seed,
            job.country,
            out,
            job.started_at,
            job.finished_at
          );
        } catch (
          ingestError
        ) {
          console.error(
            "[INGEST] UNHANDLED ERROR:",
            ingestError instanceof Error
              ? ingestError.message
              : ingestError
          );
        }
      } catch (e) {
        job.status =
          "failed";

        job.message =
          e instanceof Error
            ? e.message
            : "Unhandled worker error";

        job.finished_at =
          new Date().toISOString();

        try {
          await ingestSpyAds(
            job.seed,
            job.country,
            {
              status:
                "failed",

              message:
                job.message,

              results:
                job.results ||
                [],
            },
            job.started_at,
            job.finished_at
          );
        } catch (
          ingestError
        ) {
          console.error(
            "[INGEST] FAILED-JOB REPORT ERROR:",
            ingestError instanceof Error
              ? ingestError.message
              : ingestError
          );
        }
      } finally {
        if (
          !job.finished_at
        ) {
          job.finished_at =
            new Date().toISOString();
        }
      }
    });
  }
);

/* =========================================================
   GET SINGLE JOB
========================================================= */

app.get(
  "/jobs/:id",
  auth,
  (req, res) => {
    const job = jobs.get(
      req.params.id
    );

    if (!job) {
      return res
        .status(404)
        .json({
          error:
            "Job not found",
        });
    }

    return res.json(job);
  }
);

/* =========================================================
   GET JOB LIST
========================================================= */

app.get(
  "/jobs",
  auth,
  (_req, res) => {
    const allJobs = [
      ...jobs.values(),
    ].sort((a, b) =>
      b.created_at.localeCompare(
        a.created_at
      )
    );

    return res.json(
      allJobs
    );
  }
);

/* =========================================================
   TRANSPARENCY CSV IMPORT
========================================================= */

app.post(
  "/import-transparency-csv",
  auth,
  async (req, res) => {
    try {
      const schema = z.object({
        csvText: z
          .string()
          .min(1)
          .max(10_000_000),

        searchType: z
          .enum(["domain", "advertiser"])
          .optional(),

        seed: z
          .string()
          .max(500)
          .optional(),

        resolveImages: z
          .boolean()
          .optional(),

        concurrency: z
          .number()
          .int()
          .min(1)
          .max(5)
          .optional(),
      });

      const parsed = schema.safeParse(req.body);

      if (!parsed.success) {
        return res.status(400).json({
          ok: false,
          error: parsed.error.flatten(),
        });
      }

      const imported = parseTransparencyCsv(
        parsed.data.csvText
      );

      let imageResolution:
        | {
            total: number;
            resolved: number;
            unresolved: number;
            success_rate: number;
            results: Awaited<
              ReturnType<typeof resolveDomainsFromImages>
            >;
          }
        | undefined;

      if (
        parsed.data.resolveImages &&
        imported.imageUrls.length > 0
      ) {
        // Keep each OCR batch bounded so one large CSV does not
        // overload the worker. Process all image URLs in chunks.
        const allResults: Awaited<
          ReturnType<typeof resolveDomainsFromImages>
        > = [];

        const chunkSize = 100;

        for (
          let offset = 0;
          offset < imported.imageUrls.length;
          offset += chunkSize
        ) {
          const chunk = imported.imageUrls.slice(
            offset,
            offset + chunkSize
          );

          const chunkResults =
            await resolveDomainsFromImages(
              chunk,
              parsed.data.concurrency ?? 2
            );

          allResults.push(...chunkResults);
        }

        const resolved = allResults.filter(
          (item) => item.primaryDomain
        );

        imageResolution = {
          total: allResults.length,
          resolved: resolved.length,
          unresolved:
            allResults.length - resolved.length,
          success_rate:
            allResults.length > 0
              ? Number(
                  (
                    (resolved.length /
                      allResults.length) *
                    100
                  ).toFixed(2)
                )
              : 0,
          results: allResults,
        };
      }

      let databaseIngest: any = undefined;

      if (parsed.data.searchType === "domain") {
        const seed = (parsed.data.seed || "").trim();

        if (!seed) {
          return res.status(400).json({
            ok: false,
            error: "seed is required when searchType=domain",
          });
        }

        databaseIngest =
          await ingestDomainCsvToSupabase(
            seed,
            imported.rows
          );
      }

      if (
        parsed.data.searchType === "advertiser" &&
        parsed.data.resolveImages === true
      ) {
        const seedAdvertiser =
          (parsed.data.seed || "").trim() ||
          imported.advertisers[0]?.advertiserId ||
          "unknown";

        if (!imageResolution) {
          return res.status(500).json({
            ok: false,
            error:
              "Image resolution was requested but no resolution result was produced",
          });
        }

        const enrichedRows =
          buildAdvertiserOcrRows(
            imported.rows as any[],
            imageResolution.results as any[]
          );

        databaseIngest =
          await ingestAdvertiserOcrToSupabase(
            seedAdvertiser,
            enrichedRows
          );
      }

      return res.json({
        ok: true,
        searchType:
          parsed.data.searchType ?? null,
        seed:
          parsed.data.seed ?? null,
        summary: {
          totalRows: imported.totalRows,
          validRows: imported.validRows,
          advertiserCount:
            imported.advertisers.length,
          imageCount:
            imported.imageUrls.length,
        },
        advertisers: imported.advertisers,
        imageUrls: imported.imageUrls,
        rows: imported.rows,
        imageResolution,
        resolvedDomains:
          imageResolution
            ? [
                ...new Set(
                  imageResolution.results
                    .map((item: any) =>
                      normalizeDomain(
                        item?.primaryDomain ??
                        item?.domain ??
                        (Array.isArray(item?.domains)
                          ? item.domains[0]
                          : undefined)
                      )
                    )
                    .filter(Boolean)
                ),
              ]
            : [],
        databaseIngest,
      });
    } catch (error) {
      console.error(
        "[IMPORT TRANSPARENCY CSV ERROR]",
        error
      );

      return res.status(500).json({
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "Unknown CSV import error",
      });
    }
  }
);



async function runAutoQueueTick(): Promise<void> {
  if (!autoQueueEnabled) return;

  if (autoQueueBusy) {
    console.log("[AUTO_QUEUE] SKIP reason=busy");
    return;
  }

  autoQueueBusy = true;

  const id = crypto.randomUUID();

  const run: QueueRun = {
    id,
    status: "queued",
    created_at: new Date().toISOString(),
    country: autoQueueCountry,
    requested_limit: autoQueueLimit,
    max_depth: autoQueueMaxDepth,
    claimed_nodes: 0,
    processed_nodes: 0,
    discovered_domains: 0,
    results: [],
  };

  queueRuns.set(id, run);

  try {
    console.log(
      `[AUTO_QUEUE] START id=${id} limit=${autoQueueLimit} max_depth=${autoQueueMaxDepth} country=${autoQueueCountry}`
    );

    await processQueueRun(run);

    console.log(
      [
        "[AUTO_QUEUE] DONE",
        `id=${id}`,
        `status=${run.status}`,
        `claimed=${run.claimed_nodes}`,
        `processed=${run.processed_nodes}`,
        `domains=${run.discovered_domains}`,
      ].join(" ")
    );
  } catch (error) {
    console.error(
      `[AUTO_QUEUE] ERROR id=${id} error=${
        error instanceof Error ? error.message : String(error)
      }`
    );
  } finally {
    autoQueueBusy = false;
  }
}

function startAutoQueueScheduler(): void {
  if (!autoQueueEnabled) {
    console.log("[AUTO_QUEUE] disabled");
    return;
  }

  console.log(
    `[AUTO_QUEUE] enabled interval_ms=${autoQueueIntervalMs} limit=${autoQueueLimit} max_depth=${autoQueueMaxDepth} country=${autoQueueCountry}`
  );

  setTimeout(() => {
    void runAutoQueueTick();
  }, 15_000);

  autoQueueTimer = setInterval(() => {
    void runAutoQueueTick();
  }, autoQueueIntervalMs);

  autoQueueTimer.unref?.();
}

/* =========================================================
   SPY ADS QUEUE RUNNER
========================================================= */

app.post(
  "/spy/run-queue",
  auth,
  (req, res) => {
    const schema = z.object({
      limit: z
        .number()
        .int()
        .min(1)
        .max(3)
        .optional(),

      maxDepth: z
        .number()
        .int()
        .min(0)
        .max(3)
        .optional(),

      country: z
        .string()
        .min(2)
        .max(20)
        .optional(),
    });

    const parsed = schema.safeParse(
      req.body ?? {}
    );

    if (!parsed.success) {
      return res.status(400).json({
        ok: false,
        error: parsed.error.flatten(),
      });
    }

    const id = crypto.randomUUID();

    const run: QueueRun = {
      id,
      status: "queued",
      created_at:
        new Date().toISOString(),
      country:
        parsed.data.country ?? "US",
      requested_limit:
        parsed.data.limit ?? 1,
      max_depth:
        parsed.data.maxDepth ?? 3,
      claimed_nodes: 0,
      processed_nodes: 0,
      discovered_domains: 0,
      results: [],
    };

    queueRuns.set(id, run);

    setImmediate(async () => {
      await processQueueRun(run);
    });

    return res.status(202).json({
      ok: true,
      id,
      status: run.status,
      limit: run.requested_limit,
      maxDepth: run.max_depth,
      country: run.country,
    });
  }
);

app.get(
  "/spy/run-queue/:id",
  auth,
  (req, res) => {
    const run = queueRuns.get(
      req.params.id
    );

    if (!run) {
      return res.status(404).json({
        ok: false,
        error: "Queue run not found",
      });
    }

    return res.json({
      ok: true,
      ...run,
    });
  }
);

app.get(
  "/spy/run-queue",
  auth,
  (_req, res) => {
    const runs = [
      ...queueRuns.values(),
    ].sort((a, b) =>
      b.created_at.localeCompare(
        a.created_at
      )
    );

    return res.json({
      ok: true,
      runs,
    });
  }
);

/* =========================================================
   IMAGE -> DOMAIN
========================================================= */

app.post(
  "/resolve-image-domain",
  auth,
  async (req, res) => {
    try {
      const schema =
        z.object({
          imageUrl:
            z.string().url(),
        });

      const parsed =
        schema.safeParse(
          req.body
        );

      if (
        !parsed.success
      ) {
        return res
          .status(400)
          .json({
            error:
              parsed.error.flatten(),
          });
      }

      const result =
        await resolveDomainFromImage(
          parsed.data.imageUrl
        );

      return res.json({
        ok: true,
        result,
      });
    } catch (error) {
      console.error(
        "[RESOLVE IMAGE DOMAIN ERROR]",
        error
      );

      return res
        .status(500)
        .json({
          ok: false,

          error:
            error instanceof Error
              ? error.message
              : "Unknown image resolver error",
        });
    }
  }
);

/* =========================================================
   BATCH IMAGE -> DOMAIN
========================================================= */

app.post(
  "/resolve-image-domains",
  auth,
  async (req, res) => {
    try {
      const schema =
        z.object({
          imageUrls:
            z
              .array(
                z
                  .string()
                  .url()
              )
              .min(1)
              .max(100),

          concurrency:
            z
              .number()
              .int()
              .min(1)
              .max(5)
              .optional(),
        });

      const parsed =
        schema.safeParse(
          req.body
        );

      if (
        !parsed.success
      ) {
        return res
          .status(400)
          .json({
            error:
              parsed.error.flatten(),
          });
      }

      const results =
        await resolveDomainsFromImages(
          parsed.data.imageUrls,
          parsed.data
            .concurrency ??
            2
        );

      const resolved =
        results.filter(
          (item) =>
            item.primaryDomain
        );

      return res.json({
        ok: true,

        total:
          results.length,

        resolved:
          resolved.length,

        unresolved:
          results.length -
          resolved.length,

        success_rate:
          results.length > 0
            ? Number(
                (
                  (resolved.length /
                    results.length) *
                  100
                ).toFixed(2)
              )
            : 0,

        results,
      });
    } catch (error) {
      console.error(
        "[RESOLVE IMAGE DOMAINS ERROR]",
        error
      );

      return res
        .status(500)
        .json({
          ok: false,

          error:
            error instanceof Error
              ? error.message
              : "Unknown image resolver error",
        });
    }
  }
);

/* =========================================================
   PROCESS SAFETY
========================================================= */

process.on(
  "unhandledRejection",
  (reason) => {
    console.error(
      "[UNHANDLED REJECTION]",
      reason
    );
  }
);

process.on(
  "uncaughtException",
  (err) => {
    console.error(
      "[UNCAUGHT EXCEPTION]",
      err
    );
  }
);

/* =========================================================
   START SERVER
========================================================= */

app.listen(
  port,
  "0.0.0.0",
  () => {
    console.log(
      `GBI Research Worker v0.2.4 listening on :${port} | ingest=${Boolean(
        ingestUrl &&
          ingestToken
      )} | image-resolver=true | csv-importer=true | supabase=${Boolean(
        supabaseUrl &&
          supabaseServiceRoleKey
      )} | auto-queue=${autoQueueEnabled} | crawler-logs=${crawlerLogMode}`
    );

    startAutoQueueScheduler();
  }
);
