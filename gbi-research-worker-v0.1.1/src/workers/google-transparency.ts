import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright";

import type {
  DiscoveryResult,
  JobStatus,
} from "../types/discovery.js";

const BASE_URL = "https://adstransparency.google.com/";

type AdvertiserType =
  | "BRAND"
  | "UNKNOWN"
  | "DISCOVERY_ADVERTISER";

type Confidence =
  | "HIGH"
  | "MEDIUM"
  | "LOW";

type AdvertiserRow = {
  advertiser_name: string;
  advertiser_id?: string;

  text_ads_count: number;

  first_seen?: string;
  last_seen?: string;

  advertiser_type: AdvertiserType;
  expand: boolean;
  confidence: Confidence;
};

type DomCandidate = {
  tag?: string;
  text?: string;
  href?: string;
  ariaLabel?: string;
  role?: string;
  parentText?: string;
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
    value.includes("unusual traffic") ||
    value.includes("verify you are human")
  ) {
    return {
      status: "manual_required",
      message:
        "Human verification/CAPTCHA detected.",
    };
  }

  if (
    value.includes("access denied") ||
    value.includes("too many requests") ||
    value.includes("rate limit")
  ) {
    return {
      status: "blocked",
      message:
        "Google blocked or rate-limited this request.",
    };
  }

  return {};
}

/* =========================================================
   BRAND NORMALIZATION
========================================================= */

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
    domain
      .toLowerCase()
      .replace(
        /^https?:\/\//,
        ""
      )
      .replace(
        /^www\./,
        ""
      )
      .split("/")[0];

  const firstPart =
    hostname.split(".")[0];

  return normalizeBrandName(
    firstPart
  );
}

/* =========================================================
   ADVERTISER CLASSIFICATION
========================================================= */

function classifyAdvertiser(
  advertiserName: string,
  seedDomain: string,
  adsCount: number
): {
  type: AdvertiserType;
  expand: boolean;
  confidence: Confidence;
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
   * Strong BRAND signal:
   *
   * COMFRT
   * COMFRT LLC
   * COMFRT CLOTHING LLC
   *
   * for comfrt.com
   */
  if (
    advertiser &&
    brand &&
    (
      advertiser === brand ||
      advertiser.includes(
        brand
      ) ||
      brand.includes(
        advertiser
      )
    )
  ) {
    return {
      type: "BRAND",
      expand: false,
      confidence: "HIGH",
    };
  }

  /*
   * At DOMAIN_SEARCH stage we do NOT yet
   * know how many distinct domains this
   * advertiser runs.
   *
   * Therefore non-brand advertisers stay
   * expandable.
   *
   * ADVERTISER_SEARCH will later determine:
   *
   * 1 domain -> likely BRAND/direct
   * 2-3 domains -> UNKNOWN
   * 4+ domains -> DISCOVERY_ADVERTISER
   * 10+ domains -> POWER DISCOVERY
   */
  if (
    adsCount >= 20
  ) {
    return {
      type: "UNKNOWN",
      expand: true,
      confidence: "LOW",
    };
  }

  return {
    type: "UNKNOWN",
    expand: true,
    confidence: "MEDIUM",
  };
}

/* =========================================================
   DATE EXTRACTION
========================================================= */

function extractDates(
  text: string
): string[] {
  const patterns = [
    /\b\d{4}-\d{2}-\d{2}\b/g,

    /\b\d{1,2}\/\d{1,2}\/\d{4}\b/g,

    /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},?\s+\d{4}\b/gi,
  ];

  const found:
    string[] = [];

  for (
    const pattern
    of patterns
  ) {
    const matches =
      text.match(
        pattern
      ) || [];

    found.push(
      ...matches
    );
  }

  return [
    ...new Set(
      found
    ),
  ];
}

/* =========================================================
   ADVERTISER ID EXTRACTION
========================================================= */

function extractAdvertiserId(
  value: string
): string | undefined {
  const match =
    value.match(
      /\bAR[A-Z0-9_-]{5,}\b/i
    );

  if (
    !match
  ) {
    return undefined;
  }

  return match[0];
}

/* =========================================================
   LOAD DYNAMIC RESULTS
========================================================= */

async function expandResults(
  page: Page
): Promise<void> {
  /*
   * Google Transparency dynamically renders
   * additional ad/result cards.
   *
   * Scroll progressively.
   */
  for (
    let i = 0;
    i < 10;
    i++
  ) {
    await page.evaluate(
      () => {
        window.scrollTo(
          0,
          document.body.scrollHeight
        );
      }
    );

    await page.waitForTimeout(
      1200
    );
  }

  /*
   * Try visible "load more" style controls.
   */
  const possibleButtons = [
    page.getByRole(
      "button",
      {
        name: /load more/i,
      }
    ),

    page.getByRole(
      "button",
      {
        name: /show more/i,
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
    of possibleButtons
  ) {
    try {
      const button =
        locator.first();

      if (
        await button.isVisible({
          timeout: 800,
        })
      ) {
        await button.click();

        await page.waitForTimeout(
          2000
        );
      }
    } catch {}
  }
}

/* =========================================================
   DOM COLLECTION
========================================================= */

async function collectPageCandidates(
  page: Page
): Promise<DomCandidate[]> {
  return page
    .evaluate(
      () => {
        const selector = [
          "a[href]",
          "[role='link']",
          "[role='listitem']",
          "[role='row']",
          "article",
        ].join(",");

        const nodes =
          Array.from(
            document.querySelectorAll(
              selector
            )
          );

        return nodes
          .slice(
            0,
            1200
          )
          .map(
            (
              node: any
            ) => {
              const anchor =
                node.tagName === "A"
                  ? node
                  : node.querySelector?.(
                      "a[href]"
                    );

              const parent =
                node.parentElement;

              return {
                tag:
                  node.tagName || "",

                text:
                  (
                    node.innerText ||
                    node.textContent ||
                    ""
                  )
                    .replace(
                      /\s+/g,
                      " "
                    )
                    .trim()
                    .slice(
                      0,
                      2500
                    ),

                href:
                  anchor?.href || "",

                ariaLabel:
                  node.getAttribute?.(
                    "aria-label"
                  ) || "",

                role:
                  node.getAttribute?.(
                    "role"
                  ) || "",

                parentText:
                  (
                    parent?.innerText ||
                    parent?.textContent ||
                    ""
                  )
                    .replace(
                      /\s+/g,
                      " "
                    )
                    .trim()
                    .slice(
                      0,
                      2500
                    ),
              };
            }
          )
          .filter(
            (
              item: any
            ) =>
              item.text ||
              item.href ||
              item.ariaLabel
          );
      }
    )
    .catch(
      () => []
    );
}

/* =========================================================
   NAME EXTRACTION
========================================================= */

function cleanAdvertiserName(
  text: string,
  advertiserId?: string
): string {
  let value =
    normalizeText(
      text
    );

  if (
    advertiserId
  ) {
    value =
      value.replace(
        new RegExp(
          advertiserId,
          "gi"
        ),
        ""
      );
  }

  value =
    value
      .replace(
        /advertiser details/gi,
        ""
      )
      .replace(
        /\badvertiser\b/gi,
        ""
      )
      .replace(
        /\babout this advertiser\b/gi,
        ""
      )
      .replace(
        /\s+/g,
        " "
      )
      .trim();

  /*
   * Avoid turning an entire giant card
   * into advertiser name.
   */
  if (
    value.length >
    180
  ) {
    const parts =
      value.split(
        /[|•·]/g
      );

    value =
      normalizeText(
        parts[0]
      );
  }

  /*
   * Reject obvious bad names.
   */
  if (
    value.length > 180
  ) {
    return "";
  }

  return value;
}

/* =========================================================
   PARSE ADVERTISERS
========================================================= */

async function parseAdvertisers(
  page: Page,
  seedDomain: string
): Promise<{
  advertisers:
    AdvertiserRow[];

  diagnostics:
    DomCandidate[];
}> {
  const candidates =
    await collectPageCandidates(
      page
    );

  type TempAdvertiser = {
    name: string;
    id?: string;

    count: number;

    dates: string[];

    samples: string[];
  };

  const map =
    new Map<
      string,
      TempAdvertiser
    >();

  for (
    const candidate
    of candidates
  ) {
    const combined =
      normalizeText(
        [
          candidate.text,
          candidate.href,
          candidate.ariaLabel,
          candidate.parentText,
        ].join(
          " "
        )
      );

    const lower =
      combined.toLowerCase();

    const advertiserId =
      extractAdvertiserId(
        combined
      );

    /*
     * Candidate must contain an advertiser
     * indicator or advertiser ID.
     */
    const looksRelevant =
      !!advertiserId ||
      lower.includes(
        "advertiser"
      );

    if (
      !looksRelevant
    ) {
      continue;
    }

    /*
     * Prefer visible text first.
     */
    let advertiserName =
      cleanAdvertiserName(
        candidate.text || "",
        advertiserId
      );

    /*
     * If candidate itself has no usable name,
     * try surrounding parent card text.
     */
    if (
      !advertiserName
    ) {
      advertiserName =
        cleanAdvertiserName(
          candidate.parentText ||
            "",
          advertiserId
        );
    }

    /*
     * If name is still empty,
     * temporarily keep the ID.
     *
     * Diagnostics will let us map
     * the exact DOM next.
     */
    if (
      !advertiserName &&
      advertiserId
    ) {
      advertiserName =
        advertiserId;
    }

    if (
      !advertiserName &&
      !advertiserId
    ) {
      continue;
    }

    const key =
      advertiserId ||
      advertiserName.toLowerCase();

    const dates =
      extractDates(
        combined
      );

    const current =
      map.get(
        key
      );

    if (
      current
    ) {
      current.count += 1;

      current.dates.push(
        ...dates
      );

      if (
        current.samples.length <
        5
      ) {
        current.samples.push(
          combined.slice(
            0,
            1200
          )
        );
      }

      /*
       * Upgrade name if previous value
       * was just advertiser ID.
       */
      if (
        current.name ===
          current.id &&
        advertiserName !==
          advertiserId
      ) {
        current.name =
          advertiserName;
      }

      continue;
    }

    map.set(
      key,
      {
        name:
          advertiserName ||
          advertiserId ||
          "Unknown Advertiser",

        id:
          advertiserId,

        count:
          1,

        dates,

        samples: [
          combined.slice(
            0,
            1200
          ),
        ],
      }
    );
  }

  const advertisers:
    AdvertiserRow[] =
    [];

  for (
    const item
    of map.values()
  ) {
    const uniqueDates =
      [
        ...new Set(
          item.dates
        ),
      ].sort();

    const classification =
      classifyAdvertiser(
        item.name,
        seedDomain,
        item.count
      );

    advertisers.push({
      advertiser_name:
        item.name,

      advertiser_id:
        item.id,

      text_ads_count:
        item.count,

      first_seen:
        uniqueDates.length
          ? uniqueDates[0]
          : undefined,

      last_seen:
        uniqueDates.length
          ? uniqueDates[
              uniqueDates.length -
                1
            ]
          : undefined,

      advertiser_type:
        classification.type,

      expand:
        classification.expand,

      confidence:
        classification.confidence,
    });
  }

  advertisers.sort(
    (
      a,
      b
    ) =>
      b.text_ads_count -
      a.text_ads_count
  );

  /*
   * Keep the most useful DOM samples.
   */
  const diagnostics =
    candidates
      .filter(
        (
          item
        ) => {
          const value =
            normalizeText(
              [
                item.text,
                item.href,
                item.ariaLabel,
                item.parentText,
              ].join(
                " "
              )
            );

          return (
            value
              .toLowerCase()
              .includes(
                "advertiser"
              ) ||
            /AR[A-Z0-9_-]{5,}/i.test(
              value
            )
          );
        }
      )
      .slice(
        0,
        80
      );

  return {
    advertisers,
    diagnostics,
  };
}

/* =========================================================
   DEBUG LOGGING
========================================================= */

function debugDomainSearch(
  seed: string,
  country: string | undefined,
  sourceUrl: string,
  advertisers: AdvertiserRow[],
  diagnostics: DomCandidate[]
): void {
  console.log(
    "========== SPY ADS DEBUG =========="
  );

  console.log(
    "MODE: DOMAIN_SEARCH"
  );

  console.log(
    "SEED DOMAIN:",
    seed
  );

  console.log(
    "COUNTRY:",
    country ||
      "anywhere"
  );

  console.log(
    "FORMAT: TEXT"
  );

  console.log(
    "SOURCE URL:",
    sourceUrl
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
    "DIAGNOSTICS:",
    JSON.stringify(
      diagnostics,
      null,
      2
    )
  );

  console.log(
    "========== END SPY ADS DEBUG =========="
  );
}

/* =========================================================
   MAIN
   MODE 1:
   DOMAIN -> ADVERTISERS
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
          width: 1440,
          height: 1100,
        },

        userAgent:
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
          "AppleWebKit/537.36 (KHTML, like Gecko) " +
          "Chrome/131.0.0.0 Safari/537.36",
      });

    const page =
      await context.newPage();

    /*
     * Direct DOMAIN query.
     *
     * TEXT ONLY.
     */
    const params =
      new URLSearchParams();

    params.set(
      "domain",
      seed
    );

    params.set(
      "format",
      "TEXT"
    );

    params.set(
      "region",
      country ||
        "anywhere"
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

    /*
     * Allow Google SPA to render.
     */
    await page.waitForTimeout(
      5000
    );

    let body =
      await page
        .locator(
          "body"
        )
        .innerText()
        .catch(
          () => ""
        );

    const initialBlock =
      detectBlockState(
        body
      );

    if (
      initialBlock.status
    ) {
      return {
        ...initialBlock,
        results: [],
      };
    }

    /*
     * Load more public cards.
     */
    await expandResults(
      page
    );

    body =
      await page
        .locator(
          "body"
        )
        .innerText()
        .catch(
          () => ""
        );

    const afterLoadBlock =
      detectBlockState(
        body
      );

    if (
      afterLoadBlock.status
    ) {
      return {
        ...afterLoadBlock,
        results: [],
      };
    }

    /*
     * Parse DOMAIN -> Advertisers.
     */
    const parsed =
      await parseAdvertisers(
        page,
        seed
      );

    /*
     * IMPORTANT DEBUG.
     *
     * This lets Railway Deploy Logs show
     * exactly what Google rendered.
     */
    debugDomainSearch(
      seed,
      country,
      page.url(),
      parsed.advertisers,
      parsed.diagnostics
    );

    /*
     * Current DiscoveryResult schema is
     * domain-oriented.
     *
     * For now advertiser data stays in
     * raw_payload until Mode 1 is verified.
     */
    const results:
      DiscoveryResult[] =
      parsed.advertisers.map(
        (
          advertiser
        ) => ({
          provider:
            "google_ads_transparency",

          domain:
            seed,

          country,

          source_url:
            page.url(),

          source_ref:
            seed,

          observed_at:
            new Date()
              .toISOString(),

          raw_payload: {
            mode:
              "DOMAIN_SEARCH",

            seed_domain:
              seed,

            format:
              "TEXT",

            advertiser_name:
              advertiser
                .advertiser_name,

            advertiser_id:
              advertiser
                .advertiser_id,

            text_ads_count:
              advertiser
                .text_ads_count,

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
          },
        })
      );

    if (
      results.length ===
      0
    ) {
      return {
        status:
          "manual_required",

        message:
          "DOMAIN_SEARCH loaded successfully but no advertiser records were parsed. " +
          `seed=${seed}; ` +
          `url=${page.url()}; ` +
          "See Railway Deploy Logs between SPY ADS DEBUG markers.",

        results: [],
      };
    }

    return {
      status:
        "completed",

      message:
        `DOMAIN_SEARCH completed. ` +
        `Found ${results.length} advertiser candidate(s) for ${seed}.`,

      results,
    };
  } catch (
    error
  ) {
    console.error(
      "[SPY ADS] DOMAIN_SEARCH ERROR:",
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
