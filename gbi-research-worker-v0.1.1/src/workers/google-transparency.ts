import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
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

/* =========================================================
   TYPES
========================================================= */

type CapturedCreative = {
  advertiser_id: string;
  advertiser_name: string;

  creative_id: string;

  domain: string;

  format_code?: number;

  first_seen?: string;
  last_seen?: string;

  raw_payload?: unknown;
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

  const first =
    hostname.split(".")[0] || "";

  return normalizeBrandName(
    first
  );
}

/* =========================================================
   BRAND CLASSIFIER
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
   * At DOMAIN_SEARCH stage we cannot
   * conclusively call this affiliate/agency.
   *
   * Mode 2 will inspect how many domains
   * this advertiser runs.
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
    typeof value !== "object"
  ) {
    return undefined;
  }

  /*
   * SearchCreatives response example:
   *
   * "6": {
   *   "1": "1777706604",
   *   "2": 406772000
   * }
   */

  const seconds =
    Number(value["1"]);

  const nanos =
    Number(
      value["2"] || 0
    );

  if (
    !Number.isFinite(seconds)
  ) {
    return undefined;
  }

  const milliseconds =
    seconds * 1000 +
    Math.floor(
      nanos / 1_000_000
    );

  const date =
    new Date(milliseconds);

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
   RESPONSE JSON PARSER
========================================================= */

function parseGoogleResponseText(
  text: string
): any | undefined {
  let value =
    text.trim();

  /*
   * Handle Google's optional anti-XSSI prefix.
   */
  if (
    value.startsWith(")]}'")
  ) {
    const newline =
      value.indexOf("\n");

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

  /*
   * Fallback:
   * find first JSON object/array.
   */
  const objectStart =
    value.indexOf("{");

  const arrayStart =
    value.indexOf("[");

  let start = -1;

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
      value.slice(start)
    );
  } catch {
    return undefined;
  }
}

/* =========================================================
   RECURSIVE CREATIVE FINDER

   SearchCreatives record structure observed:

   {
     "1": "AR....",
     "2": "CR....",
     "3": {...creative...},
     "4": 1/2/3,
     "6": {...timestamp...},
     "7": {...timestamp...},
     "12": "Comfrt LLC",
     "14": "comfrt.com"
   }
========================================================= */

function extractCreativesRecursive(
  value: any,
  output: CapturedCreative[],
  seenCreativeIds: Set<string>
): void {
  if (
    value === null ||
    value === undefined
  ) {
    return;
  }

  if (
    Array.isArray(value)
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

  /*
   * Strong signature for SearchCreatives record.
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
    domain
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

        raw_payload:
          value,
      });
    }
  }

  /*
   * Continue recursive search.
   */
  for (
    const child
    of Object.values(value)
  ) {
    if (
      typeof child ===
        "object" &&
      child !== null
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
   PAGINATION TOKEN FINDER

   We don't directly replay it yet.
   We log it so we can implement pagination
   after confirming network capture.
========================================================= */

function findLikelyPaginationTokens(
  value: any,
  output: string[],
  depth = 0
): void {
  if (
    depth > 5 ||
    value === null ||
    value === undefined
  ) {
    return;
  }

  if (
    Array.isArray(value)
  ) {
    for (
      const child
      of value
    ) {
      findLikelyPaginationTokens(
        child,
        output,
        depth + 1
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

  for (
    const [
      key,
      child,
    ]
    of Object.entries(value)
  ) {
    /*
     * In observed SearchCreatives response,
     * top-level key "2" contained a long token.
     *
     * Only log long opaque strings.
     */
    if (
      key === "2" &&
      typeof child ===
        "string" &&
      child.length >= 30 &&
      !child.startsWith(
        "CR"
      )
    ) {
      output.push(
        child
      );
    }

    if (
      typeof child ===
        "object" &&
      child !== null
    ) {
      findLikelyPaginationTokens(
        child,
        output,
        depth + 1
      );
    }
  }
}

/* =========================================================
   NETWORK RESPONSE CAPTURE
========================================================= */

async function captureSearchCreativeResponse(
  response: Response,
  capturedCreatives: CapturedCreative[],
  seenCreativeIds: Set<string>,
  paginationTokens: Set<string>
): Promise<void> {
  const url =
    response.url();

  if (
    !url.includes(
      SEARCH_CREATIVES_PATH
    )
  ) {
    return;
  }

  console.log(
    "[SPY ADS NETWORK] SearchCreatives response:",
    response.status(),
    url
  );

  try {
    const text =
      await response.text();

    console.log(
      "[SPY ADS NETWORK] Response bytes:",
      text.length
    );

    const data =
      parseGoogleResponseText(
        text
      );

    if (!data) {
      console.log(
        "[SPY ADS NETWORK] Unable to parse SearchCreatives response."
      );

      return;
    }

    const before =
      capturedCreatives.length;

    extractCreativesRecursive(
      data,
      capturedCreatives,
      seenCreativeIds
    );

    const added =
      capturedCreatives.length -
      before;

    console.log(
      "[SPY ADS NETWORK] Creatives added:",
      added
    );

    const tokens:
      string[] = [];

    findLikelyPaginationTokens(
      data,
      tokens
    );

    for (
      const token
      of tokens
    ) {
      paginationTokens.add(
        token
      );
    }
  } catch (
    error
  ) {
    console.error(
      "[SPY ADS NETWORK] Response capture failed:",
      error
    );
  }
}

/* =========================================================
   PAGE LOADING
========================================================= */

async function expandPage(
  page: Page
): Promise<void> {
  /*
   * Scroll progressively rather than
   * immediately jumping only once.
   *
   * This gives Google's frontend time to
   * issue additional SearchCreatives calls.
   */
  for (
    let i = 0;
    i < 15;
    i++
  ) {
    await page.evaluate(
      () => {
        window.scrollBy(
          0,
          Math.max(
            window.innerHeight *
              0.85,
            700
          )
        );
      }
    );

    await page.waitForTimeout(
      1100
    );
  }

  /*
   * Try load/show-more controls.
   */
  const controls = [
    page.getByRole(
      "button",
      {
        name:
          /load more/i,
      }
    ),

    page.getByRole(
      "button",
      {
        name:
          /show more/i,
      }
    ),
  ];

  for (
    const locator
    of controls
  ) {
    try {
      const button =
        locator.first();

      if (
        await button.isVisible({
          timeout: 600,
        })
      ) {
        await button.click();

        await page.waitForTimeout(
          2000
        );
      }
    } catch {}
  }

  await page.waitForTimeout(
    3000
  );
}

/* =========================================================
   GROUP BY ADVERTISER
========================================================= */

function buildAdvertiserSummaries(
  creatives: CapturedCreative[],
  seedDomain: string
): AdvertiserSummary[] {
  type Temp = {
    advertiser_id: string;
    advertiser_name: string;
    domain: string;

    creativeIds:
      Set<string>;

    dates:
      string[];
  };

  const map =
    new Map<
      string,
      Temp
    >();

  for (
    const creative
    of creatives
  ) {
    /*
     * In DOMAIN_SEARCH we only care about
     * records pointing to the requested domain.
     */
    if (
      normalizeDomain(
        creative.domain
      ) !==
      normalizeDomain(
        seedDomain
      )
    ) {
      continue;
    }

    const key =
      creative.advertiser_id;

    const existing =
      map.get(key);

    if (
      existing
    ) {
      existing.creativeIds.add(
        creative.creative_id
      );

      if (
        creative.first_seen
      ) {
        existing.dates.push(
          creative.first_seen
        );
      }

      if (
        creative.last_seen
      ) {
        existing.dates.push(
          creative.last_seen
        );
      }

      continue;
    }

    const dates:
      string[] = [];

    if (
      creative.first_seen
    ) {
      dates.push(
        creative.first_seen
      );
    }

    if (
      creative.last_seen
    ) {
      dates.push(
        creative.last_seen
      );
    }

    map.set(
      key,
      {
        advertiser_id:
          creative.advertiser_id,

        advertiser_name:
          creative.advertiser_name,

        domain:
          creative.domain,

        creativeIds:
          new Set([
            creative.creative_id,
          ]),

        dates,
      }
    );
  }

  const summaries:
    AdvertiserSummary[] =
    [];

  for (
    const item
    of map.values()
  ) {
    const dates =
      [...new Set(
        item.dates
      )]
        .sort();

    const classification =
      classifyAdvertiser(
        item.advertiser_name,
        seedDomain
      );

    summaries.push({
      advertiser_id:
        item.advertiser_id,

      advertiser_name:
        item.advertiser_name,

      domain:
        item.domain,

      creative_count:
        item.creativeIds.size,

      first_seen:
        dates[0],

      last_seen:
        dates.length
          ? dates[
              dates.length - 1
            ]
          : undefined,

      advertiser_type:
        classification
          .advertiser_type,

      expand:
        classification.expand,

      confidence:
        classification.confidence,
    });
  }

  summaries.sort(
    (
      a,
      b
    ) =>
      b.creative_count -
      a.creative_count
  );

  return summaries;
}

/* =========================================================
   DEBUG
========================================================= */

function printDebug(
  seed: string,
  country: string,
  creatives: CapturedCreative[],
  advertisers: AdvertiserSummary[],
  paginationTokens: Set<string>
): void {
  console.log(
    "========== SPY ADS NETWORK V0.3 =========="
  );

  console.log(
    "MODE: DOMAIN_SEARCH_NETWORK"
  );

  console.log(
    "SEED:",
    seed
  );

  console.log(
    "COUNTRY:",
    country
  );

  console.log(
    "REQUESTED FORMAT: TEXT"
  );

  console.log(
    "CAPTURED CREATIVES:",
    creatives.length
  );

  console.log(
    "ADVERTISERS FOUND:",
    advertisers.length
  );

  console.log(
    "ADVERTISERS:",
    JSON.stringify(
      advertisers,
      null,
      2
    )
  );

  console.log(
    "CREATIVE SAMPLE:",
    JSON.stringify(
      creatives
        .slice(0, 5)
        .map(
          item => ({
            advertiser_id:
              item.advertiser_id,

            advertiser_name:
              item.advertiser_name,

            creative_id:
              item.creative_id,

            domain:
              item.domain,

            format_code:
              item.format_code,

            first_seen:
              item.first_seen,

            last_seen:
              item.last_seen,
          })
        ),
      null,
      2
    )
  );

  console.log(
    "PAGINATION TOKENS FOUND:",
    paginationTokens.size
  );

  console.log(
    "========== END SPY ADS NETWORK V0.3 =========="
  );
}

/* =========================================================
   MAIN
   DOMAIN -> NETWORK SearchCreatives -> ADVERTISERS
========================================================= */

export async function runGoogleAdsTransparency(
  seed: string,
  country?: string
): Promise<{
  status: JobStatus;
  message?: string;
  results: DiscoveryResult[];
}> {
  let browser:
    Browser | undefined;

  let context:
    BrowserContext | undefined;

  const capturedCreatives:
    CapturedCreative[] =
    [];

  const seenCreativeIds =
    new Set<string>();

  const paginationTokens =
    new Set<string>();

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

    const page =
      await context.newPage();

    /*
     * IMPORTANT:
     * Attach listener BEFORE page.goto()
     * so first SearchCreatives request
     * cannot be missed.
     */
    page.on(
      "response",
      response => {
        void captureSearchCreativeResponse(
          response,
          capturedCreatives,
          seenCreativeIds,
          paginationTokens
        );
      }
    );

    /*
     * Keep Google's own frontend responsible
     * for generating cookies/XSRF/request format.
     *
     * We DO NOT hard-code:
     * - SID
     * - SAPISID
     * - XSRF
     * - x-client-data
     * - Chrome validation headers
     */
    const params =
      new URLSearchParams();

    params.set(
      "region",
      region
    );

    params.set(
      "domain",
      seed
    );

    /*
     * Ask frontend for TEXT mode.
     */
    params.set(
      "format",
      "TEXT"
    );

    const url =
      `${BASE_URL}?${params.toString()}`;

    console.log(
      "[SPY ADS] Opening:",
      url
    );

    await page.goto(
      url,
      {
        waitUntil:
          "domcontentloaded",

        timeout:
          45000,
      }
    );

    await page.waitForTimeout(
      7000
    );

    const body =
      await page
        .locator("body")
        .innerText()
        .catch(
          () => ""
        );

    const block =
      detectBlockState(
        body
      );

    if (
      block.status
    ) {
      return {
        ...block,
        results: [],
      };
    }

    /*
     * Trigger lazy-loaded result batches.
     */
    await expandPage(
      page
    );

    /*
     * Allow final responses to finish.
     */
    await page.waitForTimeout(
      3000
    );

    const advertisers =
      buildAdvertiserSummaries(
        capturedCreatives,
        seed
      );

    printDebug(
      seed,
      region,
      capturedCreatives,
      advertisers,
      paginationTokens
    );

    /*
     * Current project schema is still
     * DiscoveryResult-oriented.
     *
     * For V0.3 return one row per advertiser.
     */
    const results:
      DiscoveryResult[] =
      advertisers.map(
        advertiser => ({
          provider:
            "google_ads_transparency",

          domain:
            seed,

          country:
            region,

          source_url:
            page.url(),

          source_ref:
            seed,

          observed_at:
            new Date()
              .toISOString(),

          raw_payload: {
            mode:
              "DOMAIN_SEARCH_NETWORK",

            requested_format:
              "TEXT",

            seed_domain:
              seed,

            advertiser_id:
              advertiser
                .advertiser_id,

            advertiser_name:
              advertiser
                .advertiser_name,

            creative_count:
              advertiser
                .creative_count,

            first_seen:
              advertiser
                .first_seen,

            last_seen:
              advertiser
                .last_seen,

            advertiser_type:
              advertiser
                .advertiser_type,

            expand:
              advertiser
                .expand,

            confidence:
              advertiser
                .confidence,

            captured_creatives:
              capturedCreatives
                .filter(
                  creative =>
                    creative
                      .advertiser_id ===
                    advertiser
                      .advertiser_id
                )
                .map(
                  creative => ({
                    creative_id:
                      creative
                        .creative_id,

                    format_code:
                      creative
                        .format_code,

                    first_seen:
                      creative
                        .first_seen,

                    last_seen:
                      creative
                        .last_seen,
                  })
                ),

            pagination_tokens_detected:
              paginationTokens.size,
          },
        })
      );

    if (
      capturedCreatives.length ===
      0
    ) {
      return {
        status:
          "manual_required",

        message:
          "Ads Transparency page loaded, but no SearchCreatives network response was captured.",

        results: [],
      };
    }

    if (
      advertisers.length ===
      0
    ) {
      return {
        status:
          "manual_required",

        message:
          `Captured ${capturedCreatives.length} creative record(s), but none matched seed domain ${seed}.`,

        results: [],
      };
    }

    return {
      status:
        "completed",

      message:
        `NETWORK DOMAIN_SEARCH completed. ` +
        `Captured ${capturedCreatives.length} creative(s) and ` +
        `${advertisers.length} advertiser(s) for ${seed}.`,

      results,
    };
  } catch (
    error
  ) {
    console.error(
      "[SPY ADS] NETWORK V0.3 ERROR:",
      error
    );

    return {
      status:
        "failed",

      message:
        error instanceof Error
          ? error.stack ||
            error.message
          : "Unknown browser error",

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
