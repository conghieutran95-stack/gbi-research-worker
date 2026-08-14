import {
  chromium,
  type APIResponse,
  type Browser,
  type BrowserContext,
  type Request,
  type Response,
} from "playwright";

import type {
  DiscoveryResult,
  JobStatus,
} from "../types/discovery.js";

const BASE_URL =
  "https://adstransparency.google.com/";

const SEARCH_CREATIVES_PATH =
  "/SearchService/SearchCreatives";

const PAGE_SIZE = 40;
const MAX_PAGES = 100;

/*
 * Confirmed from real Google request:
 * advertiser search accepts multiple AR IDs.
 *
 * Browser request observed 10 advertisers/batch.
 */
const ADVERTISER_BATCH_SIZE = 1;
const MAX_ADVERTISERS_TO_EXPAND = 1;
const MAX_ADVERTISER_PAGES = 2;
const MAX_PREVIEWS_TO_FETCH = 30;
const PREVIEW_FETCH_DELAY_MS = 450;

// V0.6.2 rate-limit protection
const RPC_MAX_RETRIES = 6;
const RPC_BASE_BACKOFF_MS = 2500;
const RPC_MAX_BACKOFF_MS = 30000;
const RPC_PAGE_DELAY_MS = 1800;
const DOMAIN_PAGE_DELAY_MS = 1500;
const ADVERTISER_BATCH_DELAY_MS = 4000;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function retryDelayMs(attempt: number, retryAfterHeader?: string): number {
  const retryAfterSeconds = Number(retryAfterHeader || "");
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
    return Math.min(retryAfterSeconds * 1000, 60000);
  }
  const exponential = Math.min(
    RPC_BASE_BACKOFF_MS * Math.pow(2, attempt),
    RPC_MAX_BACKOFF_MS
  );
  return exponential + Math.floor(Math.random() * 750);
}

/* =========================================================
   TYPES
========================================================= */

type CapturedCreative = {
  advertiser_id: string;
  advertiser_name: string;

  creative_id: string;

  domain?: string;
  preview_url?: string;

  format_code?: number;

  first_seen?: string;
  last_seen?: string;
};

type AdvertiserSummary = {
  advertiser_id: string;
  advertiser_name: string;

  domain: string;

  creative_count: number;

  first_seen?: string;
  last_seen?: string;

  advertiser_type:
    | "BRAND"
    | "UNKNOWN";

  expand: boolean;

  confidence:
    | "HIGH"
    | "MEDIUM";
};

type DomainSummary = {
  domain: string;

  creative_count: number;

  advertiser_count: number;

  advertiser_ids: string[];

  advertisers: Array<{
    advertiser_id: string;
    advertiser_name: string;
  }>;

  first_seen?: string;
  last_seen?: string;
};

type FirstSearchCapture = {
  request: Request;
  response: Response;
};

/* =========================================================
   BASIC HELPERS
========================================================= */

function normalizeText(
  value?: string | null
): string {
  return (value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeDomain(
  value: string
): string {
  return value
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0]
    .trim();
}

function normalizeBrandName(
  value: string
): string {
  return value
    .toLowerCase()
    .replace(
      /\b(llc|ltd|limited|inc|incorporated|corp|corporation|company|co|plc|gmbh|pty)\b/g,
      ""
    )
    .replace(
      /[^a-z0-9]/g,
      ""
    )
    .trim();
}

function domainBrand(
  domain: string
): string {
  const hostname =
    normalizeDomain(domain);

  return normalizeBrandName(
    hostname.split(".")[0] || ""
  );
}

function isInfrastructureDomain(
  domain: string
): boolean {
  const value =
    normalizeDomain(domain);

  const ignored = [
    "google.com",
    "googleusercontent.com",
    "gstatic.com",
    "googlesyndication.com",
    "doubleclick.net",
    "youtube.com",
    "youtu.be",
  ];

  return ignored.some(
    base =>
      value === base ||
      value.endsWith(
        `.${base}`
      )
  );
}

/* =========================================================
   CLASSIFIER
========================================================= */

function classifyAdvertiser(
  advertiserName: string,
  seedDomain: string
): {
  advertiser_type:
    | "BRAND"
    | "UNKNOWN";

  expand: boolean;

  confidence:
    | "HIGH"
    | "MEDIUM";
} {
  const advertiser =
    normalizeBrandName(
      advertiserName
    );

  const brand =
    domainBrand(
      seedDomain
    );

  /*
   * Example:
   *
   * comfrt.com
   * Comfrt LLC
   *
   * => BRAND
   * => do not expand
   */
  if (
    advertiser &&
    brand &&
    (
      advertiser === brand ||
      advertiser.includes(brand) ||
      brand.includes(advertiser)
    )
  ) {
    return {
      advertiser_type:
        "BRAND",

      expand:
        false,

      confidence:
        "HIGH",
    };
  }

  /*
   * We do NOT label affiliate yet.
   *
   * Advertiser -> Domains is what gives
   * us stronger evidence later.
   */
  return {
    advertiser_type:
      "UNKNOWN",

    expand:
      true,

    confidence:
      "MEDIUM",
  };
}

/* =========================================================
   BLOCK DETECTION
========================================================= */

function detectBlockState(
  text: string
): {
  status?: JobStatus;
  message?: string;
} {
  const value =
    text.toLowerCase();

  if (
    value.includes("captcha") ||
    value.includes(
      "unusual traffic"
    ) ||
    value.includes(
      "verify you are human"
    )
  ) {
    return {
      status:
        "manual_required",

      message:
        "Human verification/CAPTCHA detected.",
    };
  }

  if (
    value.includes(
      "access denied"
    ) ||
    value.includes(
      "too many requests"
    ) ||
    value.includes(
      "rate limit"
    )
  ) {
    return {
      status:
        "blocked",

      message:
        "Google blocked or rate-limited this request.",
    };
  }

  return {};
}

/* =========================================================
   GOOGLE TIMESTAMP
========================================================= */

function googleTimestampToIso(
  value: any
): string | undefined {
  if (
    !value ||
    typeof value !==
      "object"
  ) {
    return undefined;
  }

  const seconds =
    Number(
      value["1"]
    );

  const nanos =
    Number(
      value["2"] || 0
    );

  if (
    !Number.isFinite(
      seconds
    )
  ) {
    return undefined;
  }

  const milliseconds =
    seconds * 1000 +
    Math.floor(
      nanos /
        1_000_000
    );

  const date =
    new Date(
      milliseconds
    );

  if (
    Number.isNaN(
      date.getTime()
    )
  ) {
    return undefined;
  }

  return date.toISOString();
}

/* =========================================================
   RESPONSE PARSER
========================================================= */

function parseGoogleResponseText(
  text: string
): any | undefined {
  let value =
    text.trim();

  if (
    value.startsWith(
      ")]}'"
    )
  ) {
    const newline =
      value.indexOf(
        "\n"
      );

    if (
      newline >= 0
    ) {
      value =
        value.slice(
          newline + 1
        );
    }
  }

  try {
    return JSON.parse(
      value
    );
  } catch {}

  const objectStart =
    value.indexOf(
      "{"
    );

  const arrayStart =
    value.indexOf(
      "["
    );

  let start =
    -1;

  if (
    objectStart >= 0 &&
    arrayStart >= 0
  ) {
    start =
      Math.min(
        objectStart,
        arrayStart
      );
  } else {
    start =
      Math.max(
        objectStart,
        arrayStart
      );
  }

  if (
    start < 0
  ) {
    return undefined;
  }

  try {
    return JSON.parse(
      value.slice(
        start
      )
    );
  } catch {
    return undefined;
  }
}

/* =========================================================
   PREVIEW HELPERS (TEXT ADS)
========================================================= */

function findPreviewUrl(value: any): string | undefined {
  if (!value || typeof value !== "object") return undefined;

  const direct = value?.["3"]?.["1"]?.["4"];
  if (
    typeof direct === "string" &&
    direct.includes("displayads-formats.googleusercontent.com/ads/preview/content.js")
  ) {
    return direct;
  }

  return undefined;
}

function isLikelyDisplayDomain(domain: string): boolean {
  const value = normalizeDomain(domain);
  if (!value || isInfrastructureDomain(value)) return false;

  if (
    value.startsWith("com.google.") ||
    value.startsWith("object.") ||
    value.startsWith("array.") ||
    value.startsWith("string.") ||
    value.startsWith("function.") ||
    value.startsWith("window.") ||
    value.startsWith("document.")
  ) {
    return false;
  }

  const labels = value.split(".");
  if (labels.length < 2 || labels.length > 6) return false;

  const tld = labels[labels.length - 1];
  const codeLikeTlds = new Set([
    "includes", "prototype", "transform", "proto", "call",
    "apply", "bind", "create", "defineproperty", "entries", "values"
  ]);

  if (codeLikeTlds.has(tld)) return false;
  return true;
}

function extractCandidateDomainsFromPreview(text: string): string[] {
  const candidates = new Set<string>();

  // The text-ad renderer stores visible domains in escaped quoted strings,
  // e.g. \\x22enter.converge.ai/\\x22.
  const escapedQuoted = /\\x22((?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/.*?)?)\\x22/gi;
  let match: RegExpExecArray | null;

  while ((match = escapedQuoted.exec(text)) !== null) {
    const domain = normalizeDomain(match[1]);
    if (isLikelyDisplayDomain(domain)) {
      candidates.add(domain);
    }
  }

  // Defensive fallback for renderer variants that expose a normal URL/domain.
  const generic = /(?:https?:\/\/)?(?:www\.)?((?:[a-z0-9-]+\.)+[a-z]{2,})(?:[\/?#:\s"'<>]|$)/gi;
  while ((match = generic.exec(text)) !== null) {
    const domain = normalizeDomain(match[1]);
    if (isLikelyDisplayDomain(domain)) {
      candidates.add(domain);
    }
  }

  return [...candidates];
}

function scorePreviewDomain(domain: string, text: string): number {
  let score = 0;
  const escaped = domain.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  if (new RegExp(`\\\\x22(?:https?:\\\\/\\\\/)?(?:www\\\\.)?${escaped}(?:\\\\/[^\\\\x22]*)?\\\\x22`, "i").test(text)) {
    score += 10;
  }

  if (text.toLowerCase().includes(domain.toLowerCase())) score += 2;
  return score;
}

async function fetchPreviewDomain(
  context: BrowserContext,
  previewUrl: string
): Promise<string | undefined> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const response = await context.request.get(previewUrl, {
      headers: {
        accept: "*/*",
        referer: BASE_URL,
      },
    });

    const body = await response.text();

    if (response.ok()) {
      const domains = extractCandidateDomainsFromPreview(body)
        .map(domain => ({ domain, score: scorePreviewDomain(domain, body) }))
        .sort((a, b) => b.score - a.score);

      return domains[0]?.domain;
    }

    if (response.status() !== 429 && response.status() < 500) {
      return undefined;
    }

    await sleep(Math.min(1500 * Math.pow(2, attempt), 10000));
  }

  return undefined;
}

async function enrichTextCreativesFromPreviews(
  context: BrowserContext,
  creatives: CapturedCreative[]
): Promise<number> {
  let fetched = 0;
  let resolved = 0;

  for (const creative of creatives) {
    if (fetched >= MAX_PREVIEWS_TO_FETCH) break;
    if (creative.domain || !creative.preview_url) continue;

    fetched += 1;

    const domain = await fetchPreviewDomain(context, creative.preview_url);
    if (domain) {
      creative.domain = domain;
      resolved += 1;
      console.log(
        `[SPY ADS V0.6.2] PREVIEW ${fetched}: ${creative.creative_id} -> ${domain}`
      );
    }

    await sleep(PREVIEW_FETCH_DELAY_MS);
  }

  console.log(
    `[SPY ADS V0.6.2] PREVIEWS FETCHED=${fetched}, DOMAINS RESOLVED=${resolved}`
  );

  return resolved;
}

/* =========================================================
   CREATIVE EXTRACTION
========================================================= */

function extractCreativesRecursive(
  value: any,

  output:
    CapturedCreative[],

  seenCreativeIds:
    Set<string>
): void {
  if (
    value === null ||
    value === undefined
  ) {
    return;
  }

  if (
    Array.isArray(
      value
    )
  ) {
    for (
      const child
      of value
    ) {
      extractCreativesRecursive(
        child,
        output,
        seenCreativeIds
      );
    }

    return;
  }

  if (
    typeof value !==
    "object"
  ) {
    return;
  }

  const advertiserId =
    typeof value["1"] ===
      "string"
      ? value["1"]
      : undefined;

  const creativeId =
    typeof value["2"] ===
      "string"
      ? value["2"]
      : undefined;

  const advertiserName =
    typeof value["12"] ===
      "string"
      ? normalizeText(
          value["12"]
        )
      : undefined;

  const domain =
    typeof value["14"] ===
      "string"
      ? normalizeDomain(
          value["14"]
        )
      : undefined;

  const previewUrl =
    findPreviewUrl(value);

  /*
   * Strong signature observed in
   * SearchCreatives response.
   */
  if (
    advertiserId &&
    advertiserId.startsWith(
      "AR"
    ) &&
    creativeId &&
    creativeId.startsWith(
      "CR"
    ) &&
    advertiserName &&
    (domain || previewUrl)
  ) {
    if (
      !seenCreativeIds.has(
        creativeId
      )
    ) {
      seenCreativeIds.add(
        creativeId
      );

      output.push({
        advertiser_id:
          advertiserId,

        advertiser_name:
          advertiserName,

        creative_id:
          creativeId,

        domain,
        preview_url:
          previewUrl,

        format_code:
          typeof value["4"] ===
            "number"
            ? value["4"]
            : undefined,

        first_seen:
          googleTimestampToIso(
            value["6"]
          ),

        last_seen:
          googleTimestampToIso(
            value["7"]
          ),
      });
    }
  }

  for (
    const child
    of Object.values(
      value
    )
  ) {
    if (
      child !== null &&
      typeof child ===
        "object"
    ) {
      extractCreativesRecursive(
        child,
        output,
        seenCreativeIds
      );
    }
  }
}

/* =========================================================
   PAGINATION TOKEN
========================================================= */

function extractNextPageToken(
  data: any
): string | undefined {
  if (
    !data ||
    typeof data !==
      "object"
  ) {
    return undefined;
  }

  /*
   * Confirmed from DOMAIN mode.
   *
   * Response field "2"
   * -> request next page field "4".
   */
  const direct =
    data["2"];

  if (
    typeof direct ===
      "string" &&
    direct.length >=
      20 &&
    !direct.startsWith(
      "AR"
    ) &&
    !direct.startsWith(
      "CR"
    )
  ) {
    return direct;
  }

  const queue: Array<{
    value: any;
    depth: number;
  }> = [
    {
      value:
        data,

      depth:
        0,
    },
  ];

  while (
    queue.length
  ) {
    const current =
      queue.shift()!;

    if (
      current.depth >
      3
    ) {
      continue;
    }

    if (
      !current.value ||
      typeof current.value !==
        "object"
    ) {
      continue;
    }

    for (
      const [
        key,
        child,
      ]
      of Object.entries(
        current.value
      )
    ) {
      if (
        key === "2" &&
        typeof child ===
          "string" &&
        child.length >=
          30 &&
        !child.startsWith(
          "AR"
        ) &&
        !child.startsWith(
          "CR"
        )
      ) {
        return child;
      }

      if (
        child &&
        typeof child ===
          "object"
      ) {
        queue.push({
          value:
            child,

          depth:
            current.depth +
            1,
        });
      }
    }
  }

  return undefined;
}

/* =========================================================
   INITIAL DOMAIN REQUEST
========================================================= */

async function captureInitialSearch(
  context: BrowserContext,
  seed: string,
  region: string
): Promise<FirstSearchCapture> {
  const page = await context.newPage();

  const params = new URLSearchParams();
  params.set("region", region);
  params.set("domain", seed);
  params.set("format", "TEXT");

  const url = `${BASE_URL}?${params.toString()}`;

  console.log(
    "[SPY ADS V0.6.3] DOMAIN:",
    url
  );

  let capturedRequest: Request | undefined;
  let capturedResponse: Response | undefined;

  /*
   * Register listeners BEFORE navigation.
   *
   * Do not depend on waitForRequest/waitForResponse racing
   * against Google's SPA initialization.
   */
  const onRequest = (request: Request) => {
    if (
      request.method() === "POST" &&
      request.url().includes(SEARCH_CREATIVES_PATH)
    ) {
      if (!capturedRequest) {
        capturedRequest = request;

        console.log(
          "[SPY ADS V0.6.3] SearchCreatives REQUEST captured"
        );
      }
    }
  };

  const onResponse = (response: Response) => {
    if (
      response.url().includes(SEARCH_CREATIVES_PATH) &&
      response.status() === 200
    ) {
      if (!capturedResponse) {
        capturedResponse = response;

        console.log(
          "[SPY ADS V0.6.3] SearchCreatives RESPONSE captured"
        );
      }
    }
  };

  page.on("request", onRequest);
  page.on("response", onResponse);

  try {
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });

    /*
     * Google Ads Transparency is an SPA.
     * Give it time to initialize and fire SearchCreatives.
     *
     * Poll instead of using two independent 45s waits.
     */
    const startedAt = Date.now();
    const timeoutMs = 60000;

    while (
      Date.now() - startedAt < timeoutMs &&
      (!capturedRequest || !capturedResponse)
    ) {
      await sleep(250);
    }

    const body = await page
      .locator("body")
      .innerText()
      .catch(() => "");

    const block = detectBlockState(body);

    if (block.status) {
      throw new Error(
        block.message ||
        "Google blocked request."
      );
    }

    if (!capturedRequest) {
      throw new Error(
        `Initial SearchCreatives request was not captured for ${seed}.`
      );
    }

    /*
     * Normally request + response arrive together.
     * If request exists but response was missed by listener,
     * try to obtain its matching response directly.
     */
    if (!capturedResponse) {
      console.warn(
        `[SPY ADS V0.6.3] Request captured but response missing for ${seed}.`
      );

      const response =
        await capturedRequest.response().catch(() => null);

      if (
        response &&
        response.status() === 200
      ) {
        capturedResponse = response;
      }
    }

    if (!capturedResponse) {
      throw new Error(
        `Initial SearchCreatives response was not captured for ${seed}.`
      );
    }

    console.log(
      `[SPY ADS V0.6.3] INITIAL CAPTURE OK: ${seed}`
    );

    return {
      request: capturedRequest,
      response: capturedResponse,
    };
  } finally {
    page.off("request", onRequest);
    page.off("response", onResponse);
  }
}

/* =========================================================
   PARSE INITIAL f.req
========================================================= */

function parseInitialPayload(
  request:
    Request
): Record<string, any> {
  const postData =
    request.postData();

  if (
    !postData
  ) {
    throw new Error(
      "Initial SearchCreatives request had no POST data."
    );
  }

  const form =
    new URLSearchParams(
      postData
    );

  const raw =
    form.get(
      "f.req"
    );

  if (
    !raw
  ) {
    throw new Error(
      "Initial SearchCreatives request has no f.req."
    );
  }

  try {
    return JSON.parse(
      raw
    );
  } catch (
    error
  ) {
    throw new Error(
      `Unable to parse initial f.req: ${
        error instanceof Error
          ? error.message
          : "unknown error"
      }`
    );
  }
}

/* =========================================================
   REPLAY HEADERS
========================================================= */

async function buildReplayHeaders(
  request:
    Request
): Promise<
  Record<string, string>
> {
  const original =
    await request
      .allHeaders();

  /*
   * Do NOT hard-code Google cookies/session.
   *
   * BrowserContext handles cookies.
   */
  const allowed = [
    "accept",
    "accept-language",
    "content-type",
    "origin",
    "referer",
    "x-framework-xsrf-token",
    "x-same-domain",
  ];

  const headers:
    Record<
      string,
      string
    > = {};

  for (
    const key
    of allowed
  ) {
    const value =
      original[key];

    if (
      value
    ) {
      headers[key] =
        value;
    }
  }

  headers[
    "content-type"
  ] =
    "application/x-www-form-urlencoded";

  return headers;
}

/* =========================================================
   GENERIC RPC REQUEST
========================================================= */

async function requestRpcPage(
  context: BrowserContext,
  endpoint: string,
  headers: Record<string, string>,
  basePayload: Record<string, any>,
  token?: string
): Promise<{
  response: APIResponse;
  data: any;
  text: string;
}> {
  const payload = JSON.parse(JSON.stringify(basePayload));

  if (token) {
    payload["4"] = token;
  } else {
    delete payload["4"];
  }

  const body = new URLSearchParams();
  body.set("f.req", JSON.stringify(payload));

  let lastStatus = 0;
  let lastText = "";

  for (let attempt = 0; attempt <= RPC_MAX_RETRIES; attempt++) {
    const response = await context.request.post(endpoint, {
      headers,
      data: body.toString(),
    });

    const text = await response.text();
    lastStatus = response.status();
    lastText = text;

    if (response.ok()) {
      const data = parseGoogleResponseText(text);
      if (!data) {
        throw new Error("Unable to parse SearchCreatives RPC response.");
      }
      return { response, data, text };
    }

    const retryable =
      response.status() === 429 ||
      response.status() === 408 ||
      response.status() >= 500;

    if (!retryable || attempt >= RPC_MAX_RETRIES) {
      throw new Error(
        `SearchCreatives HTTP ${response.status()}: ${text.slice(0, 500)}`
      );
    }

    const retryAfter = response.headers()["retry-after"];
    const waitMs = retryDelayMs(attempt, retryAfter);

    console.warn(
      `[SPY ADS V0.6.2] HTTP ${response.status()} - retry ` +
      `${attempt + 1}/${RPC_MAX_RETRIES} after ${waitMs}ms`
    );

    await sleep(waitMs);
  }

  throw new Error(
    `SearchCreatives HTTP ${lastStatus}: ${lastText.slice(0, 500)}`
  );
}

/* =========================================================
   PAGINATE AN RPC PAYLOAD
========================================================= */

async function paginateRpc(
  context:
    BrowserContext,

  endpoint:
    string,

  headers:
    Record<
      string,
      string
    >,

  payload:
    Record<
      string,
      any
    >,

  output:
    CapturedCreative[],

  seenCreativeIds:
    Set<string>,

  label:
    string,

  maxPages:
    number = MAX_PAGES
): Promise<number> {
  const seenTokens =
    new Set<string>();

  let pagesLoaded =
    0;

  let token:
    string | undefined;

  while (
    pagesLoaded <
    maxPages
  ) {
    const before =
      output.length;

    const page =
      await requestRpcPage(
        context,
        endpoint,
        headers,
        payload,
        token
      );

    extractCreativesRecursive(
      page.data,
      output,
      seenCreativeIds
    );

    pagesLoaded +=
      1;

    const added =
      output.length -
      before;

    console.log(
      `[SPY ADS V0.6.2] ${label} PAGE ${pagesLoaded}: +${added}, total=${output.length}`
    );

    const nextToken =
      extractNextPageToken(
        page.data
      );

    if (
      !nextToken
    ) {
      break;
    }

    if (
      seenTokens.has(
        nextToken
      )
    ) {
      console.log(
        `[SPY ADS V0.6.2] ${label}: repeated token, stop.`
      );

      break;
    }

    seenTokens.add(
      nextToken
    );

    token =
      nextToken;

    /*
     * Avoid hammering provider.
     */
    await sleep(RPC_PAGE_DELAY_MS);
  }

  return pagesLoaded;
}

/* =========================================================
   DOMAIN MODE PAYLOAD
========================================================= */

function buildDomainPayload(
  initialPayload:
    Record<
      string,
      any
    >
): Record<
  string,
  any
> {
  const payload =
    JSON.parse(
      JSON.stringify(
        initialPayload
      )
    );

  delete payload["4"];

  return payload;
}

/* =========================================================
   ADVERTISER MODE PAYLOAD

   Confirmed from user's real browser request:

   "3": {
      "12": {
         "1": "",
         "2": true
      },
      "13": {
         "1": [
            "AR...",
            "AR..."
         ]
      }
   }
========================================================= */

function buildAdvertiserPayload(
  initialPayload:
    Record<
      string,
      any
    >,

  advertiserIds:
    string[]
): Record<
  string,
  any
> {
  const payload =
    JSON.parse(
      JSON.stringify(
        initialPayload
      )
    );

  payload["2"] =
    PAGE_SIZE;

  payload["3"] = {
    "12": {
      "1": "",
      "2": true,
    },

    "13": {
      "1":
        advertiserIds,
    },
  };

  delete payload["4"];

  return payload;
}

/* =========================================================
   BATCH
========================================================= */

function chunkArray<T>(
  items:
    T[],

  size:
    number
): T[][] {
  const result:
    T[][] = [];

  for (
    let i = 0;
    i < items.length;
    i += size
  ) {
    result.push(
      items.slice(
        i,
        i + size
      )
    );
  }

  return result;
}

/* =========================================================
   DOMAIN -> ADVERTISER SUMMARY
========================================================= */

function buildAdvertiserSummaries(
  creatives:
    CapturedCreative[],

  seedDomain:
    string
): AdvertiserSummary[] {
  type Temp = {
    advertiser_id:
      string;

    advertiser_name:
      string;

    domain:
      string;

    creativeIds:
      Set<string>;

    dates:
      string[];
  };

  const normalizedSeed =
    normalizeDomain(
      seedDomain
    );

  const map =
    new Map<
      string,
      Temp
    >();

  for (
    const creative
    of creatives
  ) {
    if (
      !creative.domain ||
      normalizeDomain(
        creative.domain
      ) !==
      normalizedSeed
    ) {
      continue;
    }

    const current =
      map.get(
        creative
          .advertiser_id
      );

    if (
      current
    ) {
      current
        .creativeIds
        .add(
          creative
            .creative_id
        );

      if (
        creative
          .first_seen
      ) {
        current
          .dates
          .push(
            creative
              .first_seen
          );
      }

      if (
        creative
          .last_seen
      ) {
        current
          .dates
          .push(
            creative
              .last_seen
          );
      }

      continue;
    }

    const dates:
      string[] = [];

    if (
      creative
        .first_seen
    ) {
      dates.push(
        creative
          .first_seen
      );
    }

    if (
      creative
        .last_seen
    ) {
      dates.push(
        creative
          .last_seen
      );
    }

    map.set(
      creative
        .advertiser_id,
      {
        advertiser_id:
          creative
            .advertiser_id,

        advertiser_name:
          creative
            .advertiser_name,

        domain:
          creative.domain,

        creativeIds:
          new Set([
            creative
              .creative_id,
          ]),

        dates,
      }
    );
  }

  const result:
    AdvertiserSummary[] =
    [];

  for (
    const item
    of map.values()
  ) {
    const dates =
      [
        ...new Set(
          item.dates
        ),
      ].sort();

    const classification =
      classifyAdvertiser(
        item.advertiser_name,
        seedDomain
      );

    result.push({
      advertiser_id:
        item.advertiser_id,

      advertiser_name:
        item.advertiser_name,

      domain:
        item.domain,

      creative_count:
        item
          .creativeIds
          .size,

      first_seen:
        dates[0],

      last_seen:
        dates.length
          ? dates[
              dates.length -
                1
            ]
          : undefined,

      advertiser_type:
        classification
          .advertiser_type,

      expand:
        classification
          .expand,

      confidence:
        classification
          .confidence,
    });
  }

  return result.sort(
    (
      a,
      b
    ) =>
      b.creative_count -
      a.creative_count
  );
}

/* =========================================================
   ADVERTISER -> DOMAIN SUMMARY
========================================================= */

function buildDomainSummaries(
  creatives:
    CapturedCreative[],

  seedDomain:
    string
): DomainSummary[] {
  type Temp = {
    domain:
      string;

    creativeIds:
      Set<string>;

    advertisers:
      Map<
        string,
        string
      >;

    dates:
      string[];
  };

  const seed =
    normalizeDomain(
      seedDomain
    );

  const map =
    new Map<
      string,
      Temp
    >();

  for (
    const creative
    of creatives
  ) {
    if (!creative.domain) {
      continue;
    }

    const domain =
      normalizeDomain(
        creative.domain
      );

    if (
      !domain ||
      domain === seed ||
      isInfrastructureDomain(
        domain
      )
    ) {
      continue;
    }

    const current =
      map.get(
        domain
      );

    if (
      current
    ) {
      current
        .creativeIds
        .add(
          creative
            .creative_id
        );

      current
        .advertisers
        .set(
          creative
            .advertiser_id,

          creative
            .advertiser_name
        );

      if (
        creative
          .first_seen
      ) {
        current
          .dates
          .push(
            creative
              .first_seen
          );
      }

      if (
        creative
          .last_seen
      ) {
        current
          .dates
          .push(
            creative
              .last_seen
          );
      }

      continue;
    }

    const advertisers =
      new Map<
        string,
        string
      >();

    advertisers.set(
      creative
        .advertiser_id,

      creative
        .advertiser_name
    );

    const dates:
      string[] = [];

    if (
      creative
        .first_seen
    ) {
      dates.push(
        creative
          .first_seen
      );
    }

    if (
      creative
        .last_seen
    ) {
      dates.push(
        creative
          .last_seen
      );
    }

    map.set(
      domain,
      {
        domain,

        creativeIds:
          new Set([
            creative
              .creative_id,
          ]),

        advertisers,

        dates,
      }
    );
  }

  const result:
    DomainSummary[] =
    [];

  for (
    const item
    of map.values()
  ) {
    const dates =
      [
        ...new Set(
          item.dates
        ),
      ].sort();

    const advertisers =
      Array.from(
        item
          .advertisers
          .entries()
      )
        .map(
          ([
            advertiser_id,
            advertiser_name,
          ]) => ({
            advertiser_id,
            advertiser_name,
          })
        );

    result.push({
      domain:
        item.domain,

      creative_count:
        item
          .creativeIds
          .size,

      advertiser_count:
        advertisers.length,

      advertiser_ids:
        advertisers.map(
          advertiser =>
            advertiser
              .advertiser_id
        ),

      advertisers,

      first_seen:
        dates[0],

      last_seen:
        dates.length
          ? dates[
              dates.length -
                1
            ]
          : undefined,
    });
  }

  /*
   * Strong discovery domains first.
   *
   * More advertisers +
   * more creatives first.
   */
  return result.sort(
    (
      a,
      b
    ) => {
      if (
        b.advertiser_count !==
        a.advertiser_count
      ) {
        return (
          b.advertiser_count -
          a.advertiser_count
        );
      }

      return (
        b.creative_count -
        a.creative_count
      );
    }
  );
}

/* =========================================================
   MAIN V0.6
========================================================= */

export async function runGoogleAdsTransparency(
  seed:
    string,

  country?:
    string
): Promise<{
  status:
    JobStatus;

  message?:
    string;

  results:
    DiscoveryResult[];
}> {
  let browser:
    Browser | undefined;

  let context:
    BrowserContext | undefined;

  const region =
    country ||
    "anywhere";

  try {
    browser =
      await chromium.launch({
        headless:
          process.env
            .PLAYWRIGHT_HEADLESS !==
          "false",
      });

    context =
      await browser.newContext({
        locale:
          "en-US",

        viewport: {
          width:
            1440,

          height:
            1100,
        },

        userAgent:
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
          "AppleWebKit/537.36 (KHTML, like Gecko) " +
          "Chrome/131.0.0.0 Safari/537.36",
      });

    /* =====================================================
       STEP 1
       DOMAIN -> ADVERTISERS
    ===================================================== */

    const initial =
      await captureInitialSearch(
        context,
        seed,
        region
      );

    const endpoint =
      initial
        .request
        .url();

    const initialPayload =
      parseInitialPayload(
        initial.request
      );

    const replayHeaders =
      await buildReplayHeaders(
        initial.request
      );

    const domainCreatives:
      CapturedCreative[] =
      [];

    const domainSeenIds =
      new Set<string>();

    /*
     * PAGE 1 came from browser.
     */
    const page1Text =
      await initial
        .response
        .text();

    const page1Data =
      parseGoogleResponseText(
        page1Text
      );

    if (
      !page1Data
    ) {
      throw new Error(
        "Unable to parse DOMAIN PAGE 1."
      );
    }

    extractCreativesRecursive(
      page1Data,
      domainCreatives,
      domainSeenIds
    );

    let domainPages =
      1;

    let token =
      extractNextPageToken(
        page1Data
      );

    const seenDomainTokens =
      new Set<string>();

    while (
      token &&
      domainPages <
        MAX_PAGES
    ) {
      if (
        seenDomainTokens.has(
          token
        )
      ) {
        break;
      }

      seenDomainTokens.add(
        token
      );

      const domainPayload =
        buildDomainPayload(
          initialPayload
        );

      const next =
        await requestRpcPage(
          context,
          endpoint,
          replayHeaders,
          domainPayload,
          token
        );

      extractCreativesRecursive(
        next.data,
        domainCreatives,
        domainSeenIds
      );

      domainPages +=
        1;

      token =
        extractNextPageToken(
          next.data
        );

      await sleep(DOMAIN_PAGE_DELAY_MS);
    }

    const advertisers =
      buildAdvertiserSummaries(
        domainCreatives,
        seed
      );

    /*
     * Critical business rule:
     *
     * BRAND advertiser is NOT expanded.
     *
     * Only other advertisers become
     * discovery bridges.
     */
    const expandableAdvertisers =
      advertisers.filter(
        advertiser =>
          advertiser.expand &&
          advertiser
            .advertiser_type !==
            "BRAND"
      );

    console.log(
      "========== V0.6.2 STEP 1 =========="
    );

    console.log(
      "SEED DOMAIN:",
      seed
    );

    console.log(
      "DOMAIN PAGES:",
      domainPages
    );

    console.log(
      "DOMAIN CREATIVES:",
      domainCreatives.length
    );

    console.log(
      "ADVERTISERS FOUND:",
      advertisers.length
    );

    console.log(
      "EXPANDABLE ADVERTISERS:",
      expandableAdvertisers.length
    );

    /* =====================================================
       STEP 2
       ADVERTISERS -> DOMAINS
    ===================================================== */

    const advertiserIds =
      expandableAdvertisers
        .slice(0, MAX_ADVERTISERS_TO_EXPAND)
        .map(
          advertiser =>
            advertiser
              .advertiser_id
        );

    const batches =
      chunkArray(
        advertiserIds,
        ADVERTISER_BATCH_SIZE
      );

    const expansionCreatives:
      CapturedCreative[] =
      [];

    const expansionSeenIds =
      new Set<string>();

    let advertiserPages =
      0;

    for (
      let index = 0;
      index <
      batches.length;
      index++
    ) {
      const batch =
        batches[index];

      console.log(
        `[SPY ADS V0.6.2] Advertiser batch ${
          index + 1
        }/${batches.length}: ${batch.length} advertiser(s)`
      );

      const payload =
        buildAdvertiserPayload(
          initialPayload,
          batch
        );

      const loaded =
        await paginateRpc(
          context,
          endpoint,
          replayHeaders,
          payload,
          expansionCreatives,
          expansionSeenIds,
          `ADV-BATCH-${index + 1}`,
          MAX_ADVERTISER_PAGES
        );

      advertiserPages +=
        loaded;

      /*
       * Be conservative between batches.
       */
      await sleep(ADVERTISER_BATCH_DELAY_MS);
    }

    /* =====================================================
       STEP 2.5
       TEXT PREVIEW -> DISPLAY DOMAIN
    ===================================================== */

    const previewDomainsResolved =
      await enrichTextCreativesFromPreviews(
        context,
        expansionCreatives
      );

    /* =====================================================
       STEP 3
       CREATIVE -> UNIQUE DOMAINS
    ===================================================== */

    const discoveredDomains =
      buildDomainSummaries(
        expansionCreatives,
        seed
      );

    console.log(
      "========== SPY ADS V0.6.2 RESULT =========="
    );

    console.log(
      "SEED:",
      seed
    );

    console.log(
      "SOURCE ADVERTISERS:",
      expandableAdvertisers.length
    );

    console.log(
      "ADVERTISER BATCHES:",
      batches.length
    );

    console.log(
      "ADVERTISER PAGES:",
      advertiserPages
    );

    console.log(
      "EXPANSION CREATIVES:",
      expansionCreatives.length
    );

    console.log(
      "NEW UNIQUE DOMAINS:",
      discoveredDomains.length
    );

    console.log(
      "TOP DOMAINS:",
      JSON.stringify(
        discoveredDomains.slice(
          0,
          30
        ),
        null,
        2
      )
    );

    console.log(
      "========== END SPY ADS V0.6.2 =========="
    );

    /*
     * FINAL OUTPUT:
     *
     * One DiscoveryResult per DOMAIN.
     *
     * Domain is the final asset we care about.
     */
    const results:
      DiscoveryResult[] =
      discoveredDomains.map(
        domain => ({
          provider:
            "google_ads_transparency",

          domain:
            domain.domain,

          country:
            region,

          source_url:
            `${BASE_URL}?domain=${encodeURIComponent(
              seed
            )}`,

          source_ref:
            seed,

          observed_at:
            new Date()
              .toISOString(),

          raw_payload: {
            mode:
              "SPY_ADS_EXPANSION_V062_TEST",

            seed_domain:
              seed,

            requested_format:
              "TEXT",

            source_advertisers_found:
              advertisers.length,

            expandable_advertisers:
              expandableAdvertisers.length,

            advertiser_batches:
              batches.length,

            advertiser_pages_loaded:
              advertiserPages,

            expansion_creatives_total:
              expansionCreatives.length,

            preview_domains_resolved:
              previewDomainsResolved,

            discovered_domain:
              domain.domain,

            creative_count:
              domain.creative_count,

            advertiser_count:
              domain.advertiser_count,

            advertiser_ids:
              domain.advertiser_ids,

            advertisers:
              domain.advertisers,

            first_seen:
              domain.first_seen,

            last_seen:
              domain.last_seen,

            discovered_via:
              "ADVERTISER_EXPANSION",
          },
        })
      );

    return {
      status:
        "completed",

      message:
        `V0.6.2 completed. ` +
        `${advertisers.length} advertiser(s) found from ${seed}; ` +
        `${advertiserIds.length} advertiser(s) tested; ` +
        `${expansionCreatives.length} expansion creative(s); ` +
        `${discoveredDomains.length} new unique domain(s).`,

      results,
    };
  } catch (
    error
  ) {
    console.error(
      "[SPY ADS V0.6.2 ERROR]",
      error
    );

    return {
      status:
        "failed",

      message:
        error instanceof Error
          ? error.stack ||
            error.message
          : "Unknown V0.6 error",

      results: [],
    };
  } finally {
    if (
      context
    ) {
      await context
        .close()
        .catch(
          () => {}
        );
    }

    if (
      browser
    ) {
      await browser
        .close()
        .catch(
          () => {}
        );
    }
  }
}
