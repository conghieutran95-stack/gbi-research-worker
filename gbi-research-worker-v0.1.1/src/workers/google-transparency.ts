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
   HELPERS
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
    .replace(/[^a-z0-9]/g, "")
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
   GOOGLE RESPONSE PARSER
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
   EXTRACT CREATIVE RECORDS
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

  /*
   * Strong signature observed from
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
      child &&
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
   NETWORK CAPTURE
========================================================= */

async function captureSearchCreativeResponse(
  response: Response,
  capturedCreatives:
    CapturedCreative[],
  seenCreativeIds:
    Set<string>,
  stats: {
    responses: number;
    bytes: number;
  }
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

  stats.responses += 1;

  console.log(
    "[SPY ADS NETWORK] SearchCreatives response:",
    response.status()
  );

  try {
    const text =
      await response.text();

    stats.bytes +=
      text.length;

    const before =
      capturedCreatives.length;

    const data =
      parseGoogleResponseText(
        text
      );

    if (!data) {
      console.log(
        "[SPY ADS NETWORK] Response parse failed."
      );

      return;
    }

    extractCreativesRecursive(
      data,
      capturedCreatives,
      seenCreativeIds
    );

    const added =
      capturedCreatives.length -
      before;

    console.log(
      "[SPY ADS NETWORK] New creatives:",
      added,
      "| total:",
      capturedCreatives.length
    );
  } catch (
    error
  ) {
    console.error(
      "[SPY ADS NETWORK] Capture error:",
      error
    );
  }
}

/* =========================================================
   FRONTEND AUTO PAGINATION V0.4

   Instead of guessing Google's token payload,
   repeatedly drive the public frontend.

   Stop when multiple cycles produce no
   additional creative IDs.
========================================================= */

async function autoLoadAllResults(
  page: Page,
  capturedCreatives:
    CapturedCreative[]
): Promise<void> {
  const MAX_ROUNDS =
    40;

  const STABLE_ROUNDS_LIMIT =
    5;

  let stableRounds =
    0;

  let previousCount =
    capturedCreatives.length;

  for (
    let round = 1;
    round <=
    MAX_ROUNDS;
    round++
  ) {
    console.log(
      `[SPY ADS PAGINATION] Round ${round}, creatives=${capturedCreatives.length}`
    );

    /*
     * Scroll near bottom.
     */
    await page.evaluate(
      () => {
        window.scrollTo({
          top:
            document.body
              .scrollHeight,

          behavior:
            "smooth",
        });
      }
    );

    await page.waitForTimeout(
      1800
    );

    /*
     * Try common buttons.
     */
    const buttons = [
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

      page.getByText(
        /load more/i
      ),

      page.getByText(
        /show more/i
      ),
    ];

    for (
      const locator
      of buttons
    ) {
      try {
        const button =
          locator.first();

        if (
          await button.isVisible({
            timeout:
              350,
          })
        ) {
          await button.click();

          await page.waitForTimeout(
            1800
          );
        }
      } catch {}
    }

    /*
     * Small movement sometimes triggers
     * IntersectionObserver/lazy loader.
     */
    await page.evaluate(
      () => {
        window.scrollBy(
          0,
          -350
        );
      }
    );

    await page.waitForTimeout(
      500
    );

    await page.evaluate(
      () => {
        window.scrollTo(
          0,
          document.body
            .scrollHeight
        );
      }
    );

    await page.waitForTimeout(
      1800
    );

    const currentCount =
      capturedCreatives.length;

    if (
      currentCount >
      previousCount
    ) {
      console.log(
        "[SPY ADS PAGINATION] Added:",
        currentCount -
          previousCount
      );

      stableRounds =
        0;

      previousCount =
        currentCount;
    } else {
      stableRounds +=
        1;

      console.log(
        "[SPY ADS PAGINATION] No new creatives. Stable:",
        stableRounds,
        "/",
        STABLE_ROUNDS_LIMIT
      );
    }

    if (
      stableRounds >=
      STABLE_ROUNDS_LIMIT
    ) {
      console.log(
        "[SPY ADS PAGINATION] Stop: frontend appears exhausted."
      );

      break;
    }
  }

  /*
   * Wait for final in-flight XHR.
   */
  await page.waitForTimeout(
    3000
  );
}

/* =========================================================
   GROUP BY ADVERTISER
========================================================= */

function buildAdvertiserSummaries(
  creatives:
    CapturedCreative[],
  seedDomain: string
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

  const map =
    new Map<
      string,
      Temp
    >();

  const normalizedSeed =
    normalizeDomain(
      seedDomain
    );

  for (
    const creative
    of creatives
  ) {
    if (
      normalizeDomain(
        creative.domain
      ) !==
      normalizedSeed
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
      existing
        .creativeIds
        .add(
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
          creative
            .advertiser_id,

        advertiser_name:
          creative
            .advertiser_name,

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

  result.sort(
    (
      a,
      b
    ) =>
      b.creative_count -
      a.creative_count
  );

  return result;
}

/* =========================================================
   MAIN
========================================================= */

export async function runGoogleAdsTransparency(
  seed: string,
  country?: string
): Promise<{
  status: JobStatus;
  message?: string;
  results:
    DiscoveryResult[];
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

  const networkStats = {
    responses: 0,
    bytes: 0,
  };

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
     * Attach listener BEFORE navigation.
     */
    page.on(
      "response",
      response => {
        void captureSearchCreativeResponse(
          response,
          capturedCreatives,
          seenCreativeIds,
          networkStats
        );
      }
    );

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

    params.set(
      "format",
      "TEXT"
    );

    const url =
      `${BASE_URL}?${params.toString()}`;

    console.log(
      "[SPY ADS V0.4] Opening:",
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

    /*
     * Initial render/network batch.
     */
    await page.waitForTimeout(
      7000
    );

    const body =
      await page
        .locator(
          "body"
        )
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
     * Auto-pagination through Google's
     * own frontend.
     */
    await autoLoadAllResults(
      page,
      capturedCreatives
    );

    const advertisers =
      buildAdvertiserSummaries(
        capturedCreatives,
        seed
      );

    console.log(
      "========== SPY ADS V0.4 RESULT =========="
    );

    console.log(
      "SEED:",
      seed
    );

    console.log(
      "NETWORK RESPONSES:",
      networkStats.responses
    );

    console.log(
      "NETWORK BYTES:",
      networkStats.bytes
    );

    console.log(
      "TOTAL UNIQUE CREATIVES:",
      capturedCreatives.length
    );

    console.log(
      "TOTAL ADVERTISERS:",
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
      "========== END SPY ADS V0.4 RESULT =========="
    );

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
              "DOMAIN_SEARCH_NETWORK_V04",

            seed_domain:
              seed,

            requested_format:
              "TEXT",

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

            network_responses:
              networkStats
                .responses,

            unique_creatives_total:
              capturedCreatives
                .length,

            creatives:
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
          "No SearchCreatives data captured.",

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
          `Captured ${capturedCreatives.length} creative(s), but none matched ${seed}.`,

        results: [],
      };
    }

    return {
      status:
        "completed",

      message:
        `V0.4 completed. ` +
        `${capturedCreatives.length} unique creative(s), ` +
        `${advertisers.length} advertiser(s) for ${seed}.`,

      results,
    };
  } catch (
    error
  ) {
    console.error(
      "[SPY ADS V0.4 ERROR]",
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
