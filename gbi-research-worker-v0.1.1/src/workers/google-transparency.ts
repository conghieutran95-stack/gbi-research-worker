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

type AdvertiserRow = {
  advertiser_name: string;
  advertiser_id?: string;

  text_ads_count: number;

  first_seen?: string;
  last_seen?: string;

  advertiser_type:
    | "BRAND"
    | "UNKNOWN"
    | "DISCOVERY_ADVERTISER";

  expand: boolean;

  confidence:
    | "HIGH"
    | "MEDIUM"
    | "LOW";
};

function detectBlockState(
  text: string
): {
  status?: JobStatus;
  message?: string;
} {
  const v = text.toLowerCase();

  if (
    v.includes("captcha") ||
    v.includes("unusual traffic") ||
    v.includes("verify you are human")
  ) {
    return {
      status: "manual_required",
      message: "Human verification/CAPTCHA detected.",
    };
  }

  if (
    v.includes("access denied") ||
    v.includes("too many requests") ||
    v.includes("rate limit")
  ) {
    return {
      status: "blocked",
      message: "Google blocked or rate-limited this request.",
    };
  }

  return {};
}

/* -------------------------------------------------------
   NORMALIZATION
------------------------------------------------------- */

function normalizeText(value?: string | null): string {
  return (value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeBrandName(value: string): string {
  return value
    .toLowerCase()

    // remove legal company suffixes
    .replace(
      /\b(llc|ltd|limited|inc|incorporated|corp|corporation|company|co)\b/g,
      ""
    )

    .replace(/[^a-z0-9]/g, "")
    .trim();
}

function domainBrand(domain: string): string {
  const host = domain
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0];

  return normalizeBrandName(
    host.split(".")[0]
  );
}

/* -------------------------------------------------------
   BRAND CLASSIFIER
------------------------------------------------------- */

function classifyAdvertiser(
  advertiserName: string,
  seedDomain: string,
  adsCount: number
): {
  type:
    | "BRAND"
    | "UNKNOWN"
    | "DISCOVERY_ADVERTISER";

  expand: boolean;

  confidence:
    | "HIGH"
    | "MEDIUM"
    | "LOW";
} {
  const advertiser =
    normalizeBrandName(advertiserName);

  const brand =
    domainBrand(seedDomain);

  /*
   * Strong signal:
   *
   * COMFRT
   * COMFRT LLC
   * COMFRT INC
   *
   * vs comfrt.com
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
      type: "BRAND",
      expand: false,
      confidence: "HIGH",
    };
  }

  /*
   * Important:
   *
   * We do NOT classify an advertiser as affiliate
   * only because it has many ads.
   *
   * Multi-domain classification will become stronger
   * after ADVERTISER_SEARCH is implemented.
   */
  if (adsCount >= 20) {
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

/* -------------------------------------------------------
   DATE EXTRACTION
------------------------------------------------------- */

function extractDates(
  text: string
): string[] {
  const patterns = [
    /\b\d{4}-\d{2}-\d{2}\b/g,

    /\b\d{1,2}\/\d{1,2}\/\d{4}\b/g,

    /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},?\s+\d{4}\b/gi,
  ];

  const found: string[] = [];

  for (const pattern of patterns) {
    const matches =
      text.match(pattern) || [];

    found.push(...matches);
  }

  return [
    ...new Set(found),
  ];
}

/* -------------------------------------------------------
   ADVERTISER ID EXTRACTION
------------------------------------------------------- */

function extractAdvertiserId(
  value: string
): string | undefined {
  /*
   * Google advertiser IDs commonly appear
   * in URLs / advertiser links.
   *
   * We deliberately keep this permissive for
   * diagnostics because Google's UI may change.
   */

  const match =
    value.match(
      /\bAR[A-Z0-9_-]{5,}\b/i
    );

  return match
    ? match[0]
    : undefined;
}

/* -------------------------------------------------------
   LOAD MORE / SCROLL
------------------------------------------------------- */

async function expandResults(
  page: Page
): Promise<void> {
  /*
   * Ads Transparency uses dynamic rendering.
   *
   * Scroll several times to allow additional
   * result cards to render.
   */

  for (let i = 0; i < 8; i++) {
    await page.evaluate(() => {
      window.scrollTo(
        0,
        document.body.scrollHeight
      );
    });

    await page.waitForTimeout(1200);
  }

  /*
   * Try common "load more" controls.
   */

  const buttons = [
    page.getByRole(
      "button",
      { name: /load more/i }
    ),

    page.getByRole(
      "button",
      { name: /show more/i }
    ),

    page.getByText(
      /load more/i
    ),
  ];

  for (const locator of buttons) {
    try {
      if (
        await locator
          .first()
          .isVisible({
            timeout: 800,
          })
      ) {
        await locator
          .first()
          .click();

        await page.waitForTimeout(2000);
      }
    } catch {}
  }
}

/* -------------------------------------------------------
   DOM DIAGNOSTICS
------------------------------------------------------- */

async function collectPageCandidates(
  page: Page
): Promise<any[]> {
  return page
    .evaluate(() => {
      const selectors = [
        "a[href]",
        "[role='link']",
        "[role='listitem']",
        "article",
      ];

      const nodes =
        Array.from(
          document.querySelectorAll(
            selectors.join(",")
          )
        );

      return nodes
        .slice(0, 800)
        .map((node: any) => {
          const anchor =
            node.tagName === "A"
              ? node
              : node.querySelector?.(
                  "a[href]"
                );

          return {
            tag:
              node.tagName,

            text:
              (
                node.innerText ||
                node.textContent ||
                ""
              )
                .replace(/\s+/g, " ")
                .trim()
                .slice(0, 2500),

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
          };
        })
        .filter(
          (x: any) =>
            x.text ||
            x.href
        );
    })
    .catch(() => []);
}

/* -------------------------------------------------------
   PARSE ADVERTISERS
------------------------------------------------------- */

async function parseAdvertisers(
  page: Page,
  seedDomain: string
): Promise<{
  advertisers: AdvertiserRow[];
  diagnostics: any[];
}> {
  const candidates =
    await collectPageCandidates(page);

  type TempAdvertiser = {
    name: string;
    id?: string;

    count: number;

    dates: string[];

    samples: string[];
  };

  const advertiserMap =
    new Map<
      string,
      TempAdvertiser
    >();

  /*
   * Look for advertiser result links/cards.
   */

  for (const candidate of candidates) {
    const combined =
      normalizeText(
        `${candidate.text} ${candidate.href} ${candidate.ariaLabel}`
      );

    const lower =
      combined.toLowerCase();

    const advertiserId =
      extractAdvertiserId(
        combined
      );

    const looksLikeAdvertiser =
      advertiserId ||
      lower.includes(
        "advertiser"
      );

    if (!looksLikeAdvertiser) {
      continue;
    }

    /*
     * Try extracting advertiser name.
     *
     * Google often renders advertiser name
     * near the advertiser link/card.
     */

    let advertiserName =
      normalizeText(
        candidate.text
      );

    advertiserName =
      advertiserName
        .replace(
          /advertiser details/gi,
          ""
        )
        .replace(
          /advertiser/gi,
          ""
        )
        .trim();

    /*
     * Avoid giant card text becoming
     * advertiser name.
     */

    if (
      advertiserName.length > 160
    ) {
      advertiserName =
        advertiserName
          .split(/[|•·]/)[0]
          .trim();
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

    const existing =
      advertiserMap.get(key);

    if (existing) {
      existing.count += 1;

      existing.dates.push(
        ...dates
      );

      if (
        existing.samples.length < 3
      ) {
        existing.samples.push(
          combined.slice(
            0,
            800
          )
        );
      }

      continue;
    }

    advertiserMap.set(
      key,
      {
        name:
          advertiserName ||
          advertiserId ||
          "Unknown Advertiser",

        id:
          advertiserId,

        count: 1,

        dates,

        samples: [
          combined.slice(
            0,
            800
          ),
        ],
      }
    );
  }

  const advertisers:
    AdvertiserRow[] = [];

  for (
    const item
    of advertiserMap.values()
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
        uniqueDates[0],

      last_seen:
        uniqueDates.length
          ? uniqueDates[
              uniqueDates.length - 1
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
    (a, b) =>
      b.text_ads_count -
      a.text_ads_count
  );

  /*
   * Keep diagnostic candidates.
   *
   * If parsing isn't accurate yet,
   * the next test tells us exactly
   * what Google's DOM contains.
   */

  const diagnostics =
    candidates
      .filter((x) => {
        const text =
          `${x.text} ${x.href}`
            .toLowerCase();

        return (
          text.includes(
            "advertiser"
          ) ||
          /AR[A-Z0-9_-]{5,}/i.test(
            text
          )
        );
      })
      .slice(0, 50);

  return {
    advertisers,
    diagnostics,
  };
}

/* -------------------------------------------------------
   MAIN DOMAIN SEARCH
------------------------------------------------------- */

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
        locale: "en-US",

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
     * IMPORTANT:
     *
     * Direct DOMAIN query.
     *
     * TEXT only.
     *
     * No need to interact with search box.
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
      country || "anywhere"
    );

    const url =
      `${BASE_URL}?${params.toString()}`;

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
     * Allow Angular / SPA to render.
     */

    await page.waitForTimeout(
      5000
    );

    let body =
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

    if (block.status) {
      return {
        ...block,
        results: [],
      };
    }

    /*
     * Load more dynamic cards.
     */

    await expandResults(
      page
    );

    body =
      await page
        .locator("body")
        .innerText()
        .catch(
          () => ""
        );

    const parsed =
      await parseAdvertisers(
        page,
        seed
      );

    /*
     * IMPORTANT:
     *
     * DiscoveryResult currently has
     * a domain-oriented schema.
     *
     * For V0.2 we store advertiser
     * data inside raw_payload.
     *
     * After Mode 1 works, we'll update
     * the permanent database schema.
     */

    const results:
      DiscoveryResult[] =
      parsed.advertisers.map(
        (advertiser) => ({
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
              advertiser.advertiser_name,

            advertiser_id:
              advertiser.advertiser_id,

            text_ads_count:
              advertiser.text_ads_count,

            first_seen:
              advertiser.first_seen,

            last_seen:
              advertiser.last_seen,

            advertiser_type:
              advertiser.advertiser_type,

            expand:
              advertiser.expand,

            confidence:
              advertiser.confidence,
          },
        })
      );

    /*
     * If no advertiser parsed,
     * DO NOT pretend success.
     *
     * Return diagnostics so we can
     * map Google's real DOM precisely.
     */

    if (
      results.length === 0
    ) {
      return {
        status:
          "manual_required",

        message:
          "DOMAIN_SEARCH loaded successfully but advertiser parser found no advertiser records. " +
          `seed=${seed}; ` +
          `url=${page.url()}; ` +
          `diagnostics=${JSON.stringify(
            parsed.diagnostics
          )}`,

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
  } catch (e) {
    return {
      status:
        "failed",

      message:
        e instanceof Error
          ? e.stack ||
            e.message
          : "Unknown browser error",

      results: [],
    };
  } finally {
    if (context) {
      await context
        .close()
        .catch(() => {});
    }

    if (browser) {
      await browser
        .close()
        .catch(() => {});
    }
  }
}
