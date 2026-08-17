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

const serpApiKey = process.env.SERPAPI_API_KEY || "";
const serpApiEnabled =
  (process.env.SERPAPI_ENABLED || "false").trim().toLowerCase() === "true";
const serpApiMaxPagesPerAdvertiser = Math.max(
  1,
  Math.min(10, Number(process.env.SERPAPI_MAX_PAGES_PER_ADVERTISER || 2))
);
const serpApiMaxAdvertisersPerSeed = Math.max(
  1,
  Math.min(100, Number(process.env.SERPAPI_MAX_ADVERTISERS_PER_SEED || 20))
);
const serpApiMaxDetailsPerAdvertiser = Math.max(
  0,
  Math.min(50, Number(process.env.SERPAPI_MAX_DETAILS_PER_ADVERTISER || 10))
);
const serpApiFallbackOnEmpty =
  (process.env.SERPAPI_FALLBACK_ON_EMPTY || "true").trim().toLowerCase() === "true";
const serpApiTimeoutMs = Math.max(
  10_000,
  Number(process.env.SERPAPI_TIMEOUT_MS || 45_000)
);


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
   SERPAPI GOOGLE ADS TRANSPARENCY PROVIDER
========================================================= */

type SerpApiCreative = {
  advertiser_id?: string;
  advertiser?: string;
  ad_creative_id?: string;
  format?: string;
  target_domain?: string;
  link?: string;
  visible_link?: string;
  image?: string;
  first_shown?: number | string;
  last_shown?: number | string;
  total_days_shown?: number;
  details_link?: string;
  serpapi_details_link?: string;
};

type SerpApiStats = {
  api_requests: number;
  advertiser_count: number;
  pages_fetched: number;
  details_fetched: number;
  domains_discovered: number;
};

const serpRegionByCountry: Record<string, string> = {
  US: "2840",
  GB: "2826",
  UK: "2826",
  CA: "2124",
  AU: "2036",
  DE: "2276",
  FR: "2250",
  IT: "2380",
  ES: "2724",
  NL: "2528",
  NZ: "2554",
  SG: "2702",
  HK: "2344",
  JP: "2392",
  KR: "2410",
};

function serpRegion(country?: string): string | undefined {
  const key = (country || "").trim().toUpperCase();
  return serpRegionByCountry[key];
}

function unixToIso(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value > 10_000_000_000 ? value : value * 1000;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
  if (typeof value === "string" && value.trim()) {
    if (/^\d+$/.test(value.trim())) {
      return unixToIso(Number(value.trim()));
    }
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
  return undefined;
}

async function serpApiRequest(
  params: Record<string, string | number | undefined>,
  stats: SerpApiStats
): Promise<any> {
  if (!serpApiKey) {
    throw new Error("SERPAPI_API_KEY is missing");
  }

  const url = new URL("https://serpapi.com/search.json");
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === "") continue;
    url.searchParams.set(key, String(value));
  }
  url.searchParams.set("api_key", serpApiKey);
  url.searchParams.set("output", "json");

  stats.api_requests += 1;

  const response = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(serpApiTimeoutMs),
  });

  const text = await response.text();
  let data: any = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(
      `SerpApi returned non-JSON HTTP ${response.status}: ${text.slice(0, 300)}`
    );
  }

  if (!response.ok || data?.error) {
    throw new Error(
      `SerpApi HTTP ${response.status}: ${String(data?.error || text).slice(0, 500)}`
    );
  }

  const status = String(data?.search_metadata?.status || "Success").toLowerCase();
  if (status === "error") {
    throw new Error(`SerpApi search error: ${String(data?.error || "unknown error")}`);
  }

  return data;
}

function collectDetailDomainCandidates(detail: any): string[] {
  const candidates: string[] = [];
  const push = (value: unknown) => {
    const domain = normalizeDomain(value);
    if (domain && !candidates.includes(domain)) candidates.push(domain);
  };

  const creatives = Array.isArray(detail?.ad_creatives)
    ? detail.ad_creatives
    : [];

  for (const item of creatives) {
    push(item?.link);
    push(item?.visible_link);

    if (Array.isArray(item?.carousel_data)) {
      for (const slide of item.carousel_data) {
        push(slide?.button_link);
        push(slide?.link);
      }
    }

    if (Array.isArray(item?.images)) {
      for (const image of item.images) {
        push(image?.link);
      }
    }
  }

  return candidates;
}

async function resolveSerpApiCreativeDomain(
  creative: SerpApiCreative,
  country: string | undefined,
  stats: SerpApiStats
): Promise<string | undefined> {
  const direct = normalizeDomain(
    creative.target_domain ||
      creative.visible_link ||
      (creative.link && !creative.link.includes("googleusercontent.com")
        ? creative.link
        : undefined)
  );
  if (direct) return direct;

  // A details request is only possible when both IDs exist.
  if (!creative.advertiser_id || !creative.ad_creative_id) return undefined;

  const detail = await serpApiRequest(
    {
      engine: "google_ads_transparency_center_ad_details",
      advertiser_id: creative.advertiser_id,
      creative_id: creative.ad_creative_id,
      region: serpRegion(country),
    },
    stats
  );
  stats.details_fetched += 1;

  const candidates = collectDetailDomainCandidates(detail);
  if (candidates.length > 0) return candidates[0];

  // Some creatives are returned as a flattened image with no structured link.
  // In that case use the existing image-domain resolver as a fallback.
  const detailCreatives = Array.isArray(detail?.ad_creatives)
    ? detail.ad_creatives
    : [];

  for (const item of detailCreatives) {
    const imageUrl =
      typeof item?.image === "string" && item.image.trim()
        ? item.image.trim()
        : undefined;

    if (!imageUrl) continue;

    try {
      const resolved: any = await resolveDomainFromImage(imageUrl);
      const candidate = normalizeDomain(
        resolved?.primaryDomain ??
          resolved?.domain ??
          (Array.isArray(resolved?.domains) ? resolved.domains[0] : undefined)
      );
      if (candidate) return candidate;
    } catch (error) {
      console.warn(
        `[SERPAPI_ADVERTISER] IMAGE_RESOLVE_FAIL advertiser=${creative.advertiser_id} creative=${creative.ad_creative_id} error=${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  return undefined;
}

async function runSerpApiDomainAdvertiserDiscovery(
  seed: string,
  country?: string
): Promise<any> {
  const { seedDomain } = parseSeedCursor(seed);
  const stats: SerpApiStats = {
    api_requests: 0,
    advertiser_count: 0,
    pages_fetched: 0,
    details_fetched: 0,
    domains_discovered: 0,
  };
  const region = serpRegion(country);

  console.log(
    `[SERPAPI_DOMAIN] START seed=${seedDomain} country=${country || "any"}`
  );

  // Domain -> Advertiser must be a single SEARCH request.
  // Advertiser expansion is handled later by its own queue node, so do not
  // crawl every advertiser again here (that previously caused 1 + N requests).
  const seedSearch = await serpApiRequest(
    {
      engine: "google_ads_transparency_center",
      text: seedDomain,
      platform: "SEARCH",
      region,
      num: 100,
    },
    stats
  );
  stats.pages_fetched += 1;

  const seedCreatives: SerpApiCreative[] = Array.isArray(seedSearch?.ad_creatives)
    ? seedSearch.ad_creatives
    : [];

  const advertiserMap = new Map<
    string,
    {
      advertiser_name: string;
      creativeIds: Set<string>;
      dates: string[];
    }
  >();

  for (const creative of seedCreatives) {
    const advertiserId =
      typeof creative?.advertiser_id === "string"
        ? creative.advertiser_id.trim()
        : "";
    if (!advertiserId) continue;

    const current = advertiserMap.get(advertiserId) || {
      advertiser_name:
        typeof creative?.advertiser === "string" ? creative.advertiser : "",
      creativeIds: new Set<string>(),
      dates: [],
    };

    if (!current.advertiser_name && typeof creative?.advertiser === "string") {
      current.advertiser_name = creative.advertiser;
    }
    if (creative.ad_creative_id) current.creativeIds.add(creative.ad_creative_id);

    const first = unixToIso(creative.first_shown);
    const last = unixToIso(creative.last_shown);
    if (first) current.dates.push(first);
    if (last) current.dates.push(last);

    advertiserMap.set(advertiserId, current);
  }

  const advertisers = [...advertiserMap.entries()]
    .slice(0, serpApiMaxAdvertisersPerSeed)
    .map(([advertiser_id, item]) => {
      const dates = [...new Set(item.dates)].sort();
      const first = dates[0];
      const last = dates.length ? dates[dates.length - 1] : undefined;

      return {
        domain: seedDomain,
        creative_count: Math.max(1, item.creativeIds.size),
        first_seen: first,
        last_seen: last,
        activity_status: "UNKNOWN",
        observed_at: new Date().toISOString(),
        source_ref: seedDomain,
        raw_payload: {
          mode: "SERPAPI_DOMAIN_TO_ADVERTISER",
          provider: "serpapi",
          seed_domain: seedDomain,
          discovered_domain: seedDomain,
          advertiser_id,
          advertiser_name: item.advertiser_name,
          advertiser_count: 1,
          advertiser_ids: [advertiser_id],
          advertisers: [
            {
              advertiser_id,
              advertiser_name: item.advertiser_name,
            },
          ],
          creative_count: Math.max(1, item.creativeIds.size),
          ads_first_seen: first,
          ads_last_seen: last,
          crawler_discovered_at: new Date().toISOString(),
          crawler_last_checked_at: new Date().toISOString(),
          discovered_via: "SERPAPI_DOMAIN_TO_ADVERTISER",
          serpapi_stats: stats,
        },
      };
    });

  stats.advertiser_count = advertisers.length;
  stats.domains_discovered = advertisers.length > 0 ? 1 : 0;

  console.log(
    `[SERPAPI_DOMAIN] DONE seed=${seedDomain} advertisers=${stats.advertiser_count} requests=${stats.api_requests} pages=${stats.pages_fetched} details=${stats.details_fetched}`
  );

  return {
    status: "completed",
    provider: "serpapi",
    message:
      `SerpApi domain discovery completed. advertisers=${stats.advertiser_count}; ` +
      `requests=${stats.api_requests}; pages=${stats.pages_fetched}; details=${stats.details_fetched}.`,
    results: advertisers,
    stats,
  };
}

async function runSerpApiAdvertiserExpansion(
  advertiserId: string,
  country?: string
): Promise<any> {
  const advertiserKey = advertiserId.trim();
  const stats: SerpApiStats = {
    api_requests: 0,
    advertiser_count: 1,
    pages_fetched: 0,
    details_fetched: 0,
    domains_discovered: 0,
  };
  const region = serpRegion(country);

  console.log(
    `[SERPAPI_ADVERTISER] START advertiser=${advertiserKey} country=${country || "any"}`
  );

  const domainMap = new Map<
    string,
    {
      creativeIds: Set<string>;
      dates: string[];
    }
  >();

  let nextPageToken: string | undefined;
  // Respect the configured detail budget exactly. Set the environment value to 1
  // when one fallback detail lookup per advertiser is desired; 0 truly disables it.
  let detailBudget = serpApiMaxDetailsPerAdvertiser;
  let noNewDomainPages = 0;

  for (let page = 0; page < serpApiMaxPagesPerAdvertiser; page += 1) {
    const before = domainMap.size;
    const data = await serpApiRequest(
      {
        engine: "google_ads_transparency_center",
        advertiser_id: advertiserKey,
        platform: "SEARCH",
        region,
        num: 100,
        next_page_token: nextPageToken,
      },
      stats
    );

    stats.pages_fetched += 1;

    const creatives: SerpApiCreative[] = Array.isArray(data?.ad_creatives)
      ? data.ad_creatives
      : [];

    const creativesWithIds = creatives.filter(
      (creative) =>
        typeof creative?.ad_creative_id === "string" &&
        creative.ad_creative_id.trim()
    ).length;

    console.log(
      `[SERPAPI_ADVERTISER] PAGE advertiser=${advertiserKey} page=${page + 1} creatives=${creatives.length} creatives_with_id=${creativesWithIds} detail_budget=${detailBudget}`
    );

    const unresolvedCreatives: SerpApiCreative[] = [];

    const addAdvertiserDomain = (
      domainValue: unknown,
      creative: SerpApiCreative
    ) => {
      const domain = normalizeDomain(domainValue);
      if (!domain) return false;

      const current = domainMap.get(domain) || {
        creativeIds: new Set<string>(),
        dates: [],
      };

      if (creative.ad_creative_id) {
        current.creativeIds.add(creative.ad_creative_id);
      }

      const first = unixToIso(creative.first_shown);
      const last = unixToIso(creative.last_shown);
      if (first) current.dates.push(first);
      if (last) current.dates.push(last);

      domainMap.set(domain, current);
      return true;
    };

    // First pass: use structured destination fields from every SEARCH creative.
    // Do not spend a details request until we know the whole page gave us no domain.
    for (const creative of creatives) {
      const enrichedCreative: SerpApiCreative = {
        ...creative,
        advertiser_id: creative.advertiser_id || advertiserKey,
      };

      const directDomain = normalizeDomain(
        enrichedCreative.target_domain ||
          enrichedCreative.visible_link ||
          enrichedCreative.link
      );

      if (directDomain) {
        addAdvertiserDomain(directDomain, enrichedCreative);
      } else if (
        enrichedCreative.advertiser_id &&
        enrichedCreative.ad_creative_id
      ) {
        unresolvedCreatives.push(enrichedCreative);
      }
    }

    // Fallback only when this page produced no structured domain at all.
    // This avoids paying for a detail/OCR request when another creative on the
    // same page already exposes the destination domain directly.
    if (domainMap.size === before && detailBudget > 0) {
      for (const creative of unresolvedCreatives) {
        if (detailBudget <= 0) break;

        try {
          const resolvedDomain = await resolveSerpApiCreativeDomain(
            creative,
            country,
            stats
          );
          detailBudget -= 1;

          if (resolvedDomain) {
            addAdvertiserDomain(resolvedDomain, creative);
            break;
          }
        } catch (error) {
          detailBudget -= 1;
          console.warn(
            `[SERPAPI_ADVERTISER] DETAIL_FAIL advertiser=${advertiserKey} creative=${creative.ad_creative_id || "unknown"} error=${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
      }
    }

    const after = domainMap.size;
    if (after === before) noNewDomainPages += 1;
    else noNewDomainPages = 0;

    nextPageToken =
      typeof data?.serpapi_pagination?.next_page_token === "string"
        ? data.serpapi_pagination.next_page_token
        : undefined;

    // Stop if pagination ended. Also stop after an empty-domain page to protect quota.
    if (!nextPageToken || noNewDomainPages >= 1) break;
  }

  const results = [...domainMap.entries()].map(([domain, item]) => {
    const dates = [...new Set(item.dates)].sort();
    const first = dates[0];
    const last = dates.length ? dates[dates.length - 1] : undefined;

    return {
      domain,
      creative_count: Math.max(1, item.creativeIds.size),
      first_seen: first,
      last_seen: last,
      activity_status: "UNKNOWN",
      observed_at: new Date().toISOString(),
      source_ref: advertiserKey,
      raw_payload: {
        mode: "SERPAPI_ADVERTISER_EXPANSION",
        provider: "serpapi",
        advertiser_id: advertiserKey,
        advertiser_ids: [advertiserKey],
        advertisers: [
          {
            advertiser_id: advertiserKey,
            advertiser_name: "",
          },
        ],
        discovered_domain: domain,
        creative_count: Math.max(1, item.creativeIds.size),
        ads_first_seen: first,
        ads_last_seen: last,
        crawler_discovered_at: new Date().toISOString(),
        crawler_last_checked_at: new Date().toISOString(),
        discovered_via: "SERPAPI_ADVERTISER_EXPANSION",
        serpapi_stats: stats,
      },
    };
  });

  stats.domains_discovered = results.length;

  console.log(
    `[SERPAPI_ADVERTISER] DONE advertiser=${advertiserKey} domains=${stats.domains_discovered} requests=${stats.api_requests} pages=${stats.pages_fetched} details=${stats.details_fetched}`
  );

  return {
    status: "completed",
    provider: "serpapi",
    message:
      `SerpApi advertiser expansion completed. advertiser=${advertiserKey}; ` +
      `domains=${stats.domains_discovered}; requests=${stats.api_requests}; ` +
      `pages=${stats.pages_fetched}; details=${stats.details_fetched}.`,
    results,
    stats,
  };
}

async function runSpyAdsDiscoveryCompact(
  seed: string,
  country?: string
): Promise<any> {
  if (serpApiEnabled && serpApiKey) {
    try {
      const out = await runSerpApiDomainAdvertiserDiscovery(seed, country);
      const resultCount = Array.isArray(out?.results) ? out.results.length : 0;
      if (resultCount > 0 || !serpApiFallbackOnEmpty) {
        return out;
      }
      console.warn(
        `[SERPAPI_DOMAIN] EMPTY seed=${seed} fallback=playwright`
      );
    } catch (error) {
      console.warn(
        `[SERPAPI_DOMAIN] FAILED seed=${seed} fallback=playwright error=${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  return runGoogleAdsTransparencyCompact(seed, country);
}


/* =========================================================
   LOW-LOG CRAWLER WRAPPER
========================================================= */

const crawlerLogMode =
  (process.env.CRAWLER_LOG_MODE || "compact")
    .trim()
    .toLowerCase();


const compactLogAllowPatterns = [
  /^\[AUTO_QUEUE\]/,
  /^\[QUEUE\]/,
  /^\[CRAWL\]/,
  /^\[SUPABASE\]/,
  /^\[GLOBAL_COOLDOWN\]/,
  /^\[SPY ADS .*HTTP 429/i,
  /^\[SPY ADS .*CIRCUIT_BREAKER/i,
  /^\[SPY ADS .*RATE_LIMIT_STOP/i,
  /^\[SPY ADS .*ERROR/i,
  /^\[SERPAPI\]/,
  /^\[SERPAPI_DOMAIN\]/,
  /^\[SERPAPI_ADVERTISER\]/,
  /^GBI Research Worker/,
  /^Starting Container/,
];

function shouldKeepCompactLog(args: unknown[]): boolean {
  if (crawlerLogMode === "verbose") return true;

  const first = String(args?.[0] ?? "");

  return compactLogAllowPatterns.some((pattern) =>
    pattern.test(first)
  );
}


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

const captchaCooldownMs = Math.max(
  300_000,
  Number(process.env.CAPTCHA_COOLDOWN_MS || 3_600_000)
);


const captchaManualRequired =
  (process.env.CAPTCHA_MANUAL_REQUIRED || "true")
    .trim()
    .toLowerCase() === "true";

const sessionCooldownMs = Math.max(
  300_000,
  Number(process.env.SESSION_COOLDOWN_MS || 3_600_000)
);

let globalCooldownUntil = 0;
let globalCooldownReason: string | null = null;

function isCaptchaError(value: unknown): boolean {
  const text =
    value instanceof Error
      ? value.message
      : String(value ?? "");

  return /captcha|human verification|unusual traffic/i.test(text);
}

function activateGlobalCooldown(
  reason: string,
  durationMs = captchaCooldownMs
): void {
  globalCooldownUntil = Math.max(
    globalCooldownUntil,
    Date.now() + durationMs
  );
  globalCooldownReason = reason;

  console.warn(
    `[GLOBAL_COOLDOWN] START reason=${reason} until=${new Date(
      globalCooldownUntil
    ).toISOString()} duration_ms=${durationMs}`
  );
}

function globalCooldownRemainingMs(): number {
  return Math.max(0, globalCooldownUntil - Date.now());
}

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
  const originalWarn = console.warn;
  const originalDebug = console.debug;
  const started = Date.now();

  originalLog(
    `[CRAWL] START seed=${seed} country=${country || "US"}`
  );

  const filteredLog = (...args: unknown[]) => {
    if (shouldKeepCompactLog(args)) {
      originalLog(...args);
    }
  };

  const filteredInfo = (...args: unknown[]) => {
    if (shouldKeepCompactLog(args)) {
      originalInfo(...args);
    }
  };

  const filteredWarn = (...args: unknown[]) => {
    if (shouldKeepCompactLog(args)) {
      originalWarn(...args);
    }
  };

  console.log = filteredLog;
  console.info = filteredInfo;
  console.warn = filteredWarn;
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
    console.warn = originalWarn;
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


async function countNewDomainsBeforeIngest(
  domains: string[]
): Promise<number | undefined> {
  const normalized = [...new Set(
    domains
      .map((domain) => normalizeDomain(domain))
      .filter((domain): domain is string => Boolean(domain))
  )];

  if (normalized.length === 0) return 0;

  try {
    const out = await callSupabaseRpc(
      "spy_count_new_domains_v1",
      { p_domains: normalized },
      30_000
    );

    const count = Number(out);
    return Number.isFinite(count) ? Math.max(0, count) : undefined;
  } catch (error) {
    console.warn(
      `[YIELD] COUNT_FAIL error=${error instanceof Error ? error.message : String(error)}`
    );
    return undefined;
  }
}

async function recordAdvertiserPerformance(
  advertiserId: string,
  apiRequests: number,
  domainsFound: number,
  newDomains: number
): Promise<void> {
  try {
    await callSupabaseRpc(
      "spy_record_advertiser_performance_v1",
      {
        p_advertiser_id: advertiserId,
        p_api_requests: Math.max(0, Math.trunc(apiRequests || 0)),
        p_domains_found: Math.max(0, Math.trunc(domainsFound || 0)),
        p_new_domains: Math.max(0, Math.trunc(newDomains || 0)),
      },
      30_000
    );
  } catch (error) {
    // Yield telemetry must never block discovery/ingest.
    console.warn(
      `[YIELD] RECORD_FAIL advertiser=${advertiserId} error=${error instanceof Error ? error.message : String(error)}`
    );
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

async function claimAdvertiserQueueNodes(
  limit: number
): Promise<ClaimedQueueNode[]> {
  const data = await callSupabaseRpc(
    "spy_claim_advertiser_expansion_queue",
    {
      p_limit: limit,
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


function extractCaptchaDetected(
  workerOutput: any
): boolean {
  const texts: string[] = [];

  if (workerOutput?.message) {
    texts.push(String(workerOutput.message));
  }

  if (workerOutput?.error) {
    texts.push(String(workerOutput.error));
  }

  if (Array.isArray(workerOutput?.results)) {
    for (const result of workerOutput.results) {
      const raw = getRawPayload(result);

      if (result?.message) texts.push(String(result.message));
      if (result?.error) texts.push(String(result.error));
      if (raw?.message) texts.push(String(raw.message));
      if (raw?.error) texts.push(String(raw.error));
      if (raw?.final_status) texts.push(String(raw.final_status));
    }
  }

  const joined = texts.join(" | ");

  return /captcha|human verification|unusual traffic/i.test(joined);
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
  const dedupedRows = Array.from(
    new Map(
      rows.map((row) => [
        `${normalizeDomain(row.domain) || ""}::${String(row.advertiser_id || "")}`,
        row,
      ])
    ).values()
  ).filter((row) => row.domain && row.advertiser_id);
  const nextCursor = extractNextCursor(workerOutput);

  if (dedupedRows.length !== rows.length) {
    console.log(
      `[QUEUE] DEDUPE rows_in=${rows.length} rows_out=${dedupedRows.length}`
    );
  }

  return callSupabaseRpc(
    "spy_ingest_queue_domain_results",
    {
      p_queue_id: node.id,
      p_seed: node.node_key,
      p_depth: node.depth,
      p_results: dedupedRows,
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
    // Prefer advertiser expansion so DOMAIN -> ADVERTISER -> DOMAIN can
    // complete before we spend more searches expanding newly discovered domains.
    let nodes = await claimAdvertiserQueueNodes(
      run.requested_limit
    );

    if (nodes.length === 0) {
      nodes = await claimDomainQueueNodes(
        run.requested_limit,
        run.max_depth
      );
    }

    run.claimed_nodes = nodes.length;

    if (nodes.length === 0) {
      run.status = "completed";
      run.message =
        "No pending advertiser or domain/domain_cursor nodes available.";
      return;
    }

    for (const node of nodes) {
      try {
        console.log(
          `[QUEUE] Processing ${node.node_type}:${node.node_key} depth=${node.depth}`
        );

        const out =
          node.node_type === "advertiser"
            ? await runSerpApiAdvertiserExpansion(
                node.node_key,
                run.country
              )
            : await runSpyAdsDiscoveryCompact(
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

        const apiRequests = Math.max(
          0,
          Number(out?.stats?.api_requests || 0)
        );

        // Measure advertiser discovery yield BEFORE ingest so we can distinguish
        // genuinely new domains from domains already known in spy_domains.
        // This is database-only telemetry and does not consume SerpApi quota.
        const advertiserNewDomains =
          node.node_type === "advertiser"
            ? await countNewDomainsBeforeIngest(
                [...uniqueDomains] as string[]
              )
            : undefined;

        await ingestQueueDomainWorkerResults(
          node,
          out
        );

        if (
          node.node_type === "advertiser" &&
          advertiserNewDomains !== undefined
        ) {
          await recordAdvertiserPerformance(
            node.node_key,
            apiRequests,
            uniqueDomains.size,
            advertiserNewDomains
          );

          const yieldRatio =
            apiRequests > 0
              ? advertiserNewDomains / apiRequests
              : 0;

          console.log(
            `[YIELD] advertiser=${node.node_key} requests=${apiRequests} domains=${uniqueDomains.size} new=${advertiserNewDomains} ratio=${yieldRatio.toFixed(3)}`
          );
        }

        const workerStatus =
          String(out?.status || "").toLowerCase();

        const {
          http429Count,
          retryAfterSeconds,
        } = extractQueueRateLimitInfo(out);

        const captchaDetected =
          extractCaptchaDetected(out);

        const resultCount =
          Array.isArray(out?.results)
            ? out.results.length
            : 0;

        if (captchaDetected) {
          const captchaMessage =
            typeof out?.message === "string"
              ? out.message
              : "Human verification/CAPTCHA detected";

          activateGlobalCooldown(
            `captcha:${node.node_key}`,
            captchaCooldownMs
          );

          await finishDomainQueueNodeProtected(
            node.id,
            captchaManualRequired ? "blocked" : "failed",
            captchaMessage,
            captchaManualRequired
              ? undefined
              : Math.ceil(captchaCooldownMs / 1000),
            86_400,
            4
          );

          console.warn(
            `[QUEUE] CAPTCHA node=${node.node_key} cooldown_ms=${captchaCooldownMs} action=${
              captchaManualRequired ? "manual_required" : "retry"
            }`
          );

          run.processed_nodes += 1;

          run.results.push({
            queue_id: node.id,
            node_type: node.node_type,
            node_key: node.node_key,
            depth: node.depth,
            status: captchaManualRequired ? "skip" : "retry",
            discovered_domains: 0,
            result_count: resultCount,
            next_cursor: nextCursor,
            message: captchaMessage,
          });

          break;
        }

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

        const captchaDetected =
          isCaptchaError(error) ||
          isCaptchaError(message);

        if (captchaDetected) {
          activateGlobalCooldown(
            `captcha:${node.node_key}`,
            captchaCooldownMs
          );

          console.warn(
            `[QUEUE] CAPTCHA node=${node.node_key} retry_after_ms=${captchaCooldownMs}`
          );
        } else {
          console.error(
            `[QUEUE] FAILED node=${node.node_type}:${node.node_key} error=${message}`
          );
        }

        try {
          await finishDomainQueueNodeProtected(
            node.id,
            captchaDetected && captchaManualRequired
              ? "blocked"
              : "failed",
            message,
            captchaDetected && !captchaManualRequired
              ? Math.ceil(captchaCooldownMs / 1000)
              : undefined,
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
          status:
            captchaDetected && captchaManualRequired
              ? "skip"
              : captchaDetected
                ? "retry"
                : "failed",
          discovered_domains: 0,
          result_count: 0,
          message,
        });

        // Do not continue processing more claimed nodes after CAPTCHA.
        if (captchaDetected) {
          break;
        }
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
      "0.4.3",

    provider_primary:
      serpApiEnabled && serpApiKey ? "serpapi" : "playwright",

    serpapi_enabled:
      serpApiEnabled,

    serpapi_configured:
      Boolean(serpApiKey),

    serpapi_max_pages_per_advertiser:
      serpApiMaxPagesPerAdvertiser,

    serpapi_max_advertisers_per_seed:
      serpApiMaxAdvertisersPerSeed,

    serpapi_max_details_per_advertiser:
      serpApiMaxDetailsPerAdvertiser,

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
      "domain_and_advertiser_cost_optimized_v3",

    crawler_log_mode:
      crawlerLogMode,

    compact_crawler_logs:
      crawlerLogMode !== "verbose",

    compact_log_filter:
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

    captcha_protection:
      true,

    captcha_cooldown_ms:
      captchaCooldownMs,

    captcha_manual_required:
      captchaManualRequired,

    session_cooldown_ms:
      sessionCooldownMs,

    global_cooldown_active:
      globalCooldownRemainingMs() > 0,

    global_cooldown_remaining_ms:
      globalCooldownRemainingMs(),

    global_cooldown_reason:
      globalCooldownReason,

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
          await runSpyAdsDiscoveryCompact(
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

  const cooldownRemaining = globalCooldownRemainingMs();

  if (cooldownRemaining > 0) {
    console.log(
      `[AUTO_QUEUE] SKIP reason=global_cooldown remaining_ms=${cooldownRemaining} cooldown_reason=${globalCooldownReason || "unknown"}`
    );
    return;
  }

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
      `GBI Research Worker v0.4.3 listening on :${port} | provider=${
        serpApiEnabled && serpApiKey ? "serpapi" : "playwright"
      } | serpapi=${Boolean(serpApiKey)} | ingest=${Boolean(
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
