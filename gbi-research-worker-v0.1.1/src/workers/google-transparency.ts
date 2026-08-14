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
  advertiser_id: string;
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
   HELPERS
========================================================= */

function normalizeText(value?: string | null): string {
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

/* =========================================================
   BRAND NORMALIZATION
========================================================= */

function normalizeBrandName(value: string): string {
  return value
    .toLowerCase()
    .replace(
      /\b(llc|ltd|limited|inc|incorporated|corp|corporation|company|co|plc|gmbh|pty)\b/g,
      ""
    )
    .replace(/[^a-z0-9]/g, "")
    .trim();
}

function domainBrand(domain: string): string {
  const hostname = domain
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0];

  return normalizeBrandName(
    hostname.split(".")[0] || ""
  );
}

/* =========================================================
   CLASSIFIER
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
    normalizeBrandName(advertiserName);

  const brand =
    domainBrand(seedDomain);

  /*
   * COMFRT / COMFRT LLC / COMFRT Clothing
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
   * Chưa được phép kết luận affiliate ở Mode 1.
   * Phải sang Mode 2 xem advertiser chạy bao nhiêu domain.
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

/* =========================================================
   DATE EXTRACTION
========================================================= */

function extractDates(text: string): string[] {
  const patterns = [
    /\b\d{4}-\d{2}-\d{2}\b/g,

    /\b\d{1,2}\/\d{1,2}\/\d{4}\b/g,

    /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},?\s+\d{4}\b/gi,
  ];

  const dates: string[] = [];

  for (const pattern of patterns) {
    dates.push(
      ...(text.match(pattern) || [])
    );
  }

  return [...new Set(dates)];
}

/* =========================================================
   ADVERTISER ID
========================================================= */

function extractAdvertiserId(
  value: string
): string | undefined {
  const match =
    value.match(
      /\bAR[A-Z0-9_-]{5,}\b/i
    );

  return match?.[0];
}

/* =========================================================
   LOAD RESULTS
========================================================= */

async function expandResults(
  page: Page
): Promise<void> {
  /*
   * Google render lazy-load.
   * Scroll chậm nhiều lần.
   */
  for (let i = 0; i < 12; i++) {
    await page.evaluate(() => {
      window.scrollTo(
        0,
        document.body.scrollHeight
      );
    });

    await page.waitForTimeout(1000);
  }

  /*
   * Nếu có Load more / Show more thì click.
   */
  const controls = [
    page.getByRole(
      "button",
      { name: /load more/i }
    ),

    page.getByRole(
      "button",
      { name: /show more/i }
    ),

    page.getByText(/load more/i),

    page.getByText(/show more/i),
  ];

  for (const locator of controls) {
    try {
      const el = locator.first();

      if (
        await el.isVisible({
          timeout: 600,
        })
      ) {
        await el.click();

        await page.waitForTimeout(
          1500
        );
      }
    } catch {}
  }
}

/* =========================================================
   COLLECT DOM
========================================================= */

async function collectPageCandidates(
  page: Page
): Promise<DomCandidate[]> {
  return page
    .evaluate(() => {
      const selector = [
        "a[href]",
        "[role='link']",
        "[role='listitem']",
        "[role='row']",
        "article",
      ].join(",");

      const nodes =
        Array.from(
          document.querySelectorAll(selector)
        );

      return nodes
        .slice(0, 1500)
        .map((node: any) => {
          const anchor =
            node.tagName === "A"
              ? node
              : node.querySelector?.("a[href]");

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

            parentText:
              (
                parent?.innerText ||
                parent?.textContent ||
                ""
              )
                .replace(/\s+/g, " ")
                .trim()
                .slice(0, 2500),
          };
        })
        .filter(
          (item: any) =>
            item.text ||
            item.href ||
            item.ariaLabel
        );
    })
    .catch(() => []);
}

/* =========================================================
   UI NOISE
========================================================= */

function isNoiseText(
  value: string
): boolean {
  const v =
    normalizeText(value)
      .toLowerCase();

  const noise = [
    "explore paid promotions on youtube",
    "paid promotions on youtube",
    "youtube",
    "privacy",
    "terms",
    "about google",
    "ads transparency center",
    "search by advertiser or website",
    "search by advertiser",
    "google safety center",
    "report an ad",
    "why this ad",
    "my ad center",
  ];

  return noise.some(
    text =>
      v === text ||
      v.startsWith(text)
  );
}

/* =========================================================
   ADVERTISER NAME
========================================================= */

function extractAdvertiserName(
  candidate: DomCandidate,
  advertiserId: string
): string {
  const sources = [
    candidate.text,
    candidate.parentText,
    candidate.ariaLabel,
  ];

  for (const source of sources) {
    if (!source) continue;

    let value =
      normalizeText(source);

    value =
      value.replace(
        new RegExp(
          advertiserId,
          "gi"
        ),
        ""
      );

    value =
      value
        .replace(
          /advertiser details/gi,
          ""
        )
        .replace(
          /about this advertiser/gi,
          ""
        )
        .replace(
          /\bverified advertiser\b/gi,
          ""
        )
        .replace(
          /\badvertiser\b/gi,
          ""
        )
        .replace(
          /\bverified\b/gi,
          ""
        )
        .replace(
          /\s+/g,
          " "
        )
        .trim();

    /*
     * Nếu lấy nguyên card dài thì lấy phần đầu.
     */
    if (value.length > 140) {
      value =
        value
          .split(/[|•·\n]/g)
          .map(normalizeText)
          .filter(Boolean)[0] || "";
    }

    if (!value) continue;

    if (isNoiseText(value)) {
      continue;
    }

    if (
      /^AR[A-Z0-9_-]+$/i.test(value)
    ) {
      continue;
    }

    if (
      /^https?:\/\//i.test(value)
    ) {
      continue;
    }

    return value;
  }

  return "";
}

/* =========================================================
   PARSE DOMAIN -> ADVERTISERS
========================================================= */

async function parseAdvertisers(
  page: Page,
  seedDomain: string
): Promise<{
  advertisers: AdvertiserRow[];
  diagnostics: DomCandidate[];
}> {
  const candidates =
    await collectPageCandidates(page);

  type TempAdvertiser = {
    name: string;
    id: string;
    count: number;
    dates: string[];
    samples: string[];
  };

  const advertiserMap =
    new Map<
      string,
      TempAdvertiser
    >();

  for (const candidate of candidates) {
    const combined =
      normalizeText(
        [
          candidate.text,
          candidate.href,
          candidate.ariaLabel,
          candidate.parentText,
        ].join(" ")
      );

    /*
     * Chỉ chấp nhận record có AR ID thật.
     */
    const advertiserId =
      extractAdvertiserId(
        combined
      );

    if (!advertiserId) {
      continue;
    }

    /*
     * Phải liên quan advertiser URL thật của Transparency.
     */
    const href =
      candidate.href || "";

    const validAdvertiserRecord =
      href.includes(
        "adstransparency.google.com/advertiser/"
      ) ||
      combined.includes(
        "/advertiser/"
      );

    if (
      !validAdvertiserRecord
    ) {
      continue;
    }

    const advertiserName =
      extractAdvertiserName(
        candidate,
        advertiserId
      );

    const dates =
      extractDates(combined);

    const current =
      advertiserMap.get(
        advertiserId
      );

    if (current) {
      current.count += 1;

      current.dates.push(
        ...dates
      );

      if (
        current.samples.length < 5
      ) {
        current.samples.push(
          combined.slice(
            0,
            1200
          )
        );
      }

      /*
       * Nếu lần đầu chưa lấy được name,
       * dùng name tốt hơn ở candidate sau.
       */
      if (
        (
          !current.name ||
          current.name === advertiserId
        ) &&
        advertiserName
      ) {
        current.name =
          advertiserName;
      }

      continue;
    }

    advertiserMap.set(
      advertiserId,
      {
        name:
          advertiserName ||
          advertiserId,

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
    of advertiserMap.values()
  ) {
    const uniqueDates =
      [...new Set(item.dates)]
        .sort();

    let name =
      normalizeText(item.name);

    /*
     * Ví dụ:
     * "Comfrt LLC Verified"
     * -> "Comfrt LLC"
     */
    name =
      name
        .replace(
          /\s+Verified$/i,
          ""
        )
        .trim();

    const classification =
      classifyAdvertiser(
        name,
        seedDomain,
        item.count
      );

    advertisers.push({
      advertiser_name:
        name,

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
   * Debug chỉ giữ candidate có AR ID thật.
   */
  const diagnostics =
    candidates
      .filter(candidate => {
        const combined =
          normalizeText(
            [
              candidate.text,
              candidate.href,
              candidate.ariaLabel,
              candidate.parentText,
            ].join(" ")
          );

        return !!extractAdvertiserId(
          combined
        );
      })
      .slice(0, 100);

  return {
    advertisers,
    diagnostics,
  };
}

/* =========================================================
   DEBUG
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
    country || "anywhere"
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
   MODE 1
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
     * DIRECT DOMAIN SEARCH.
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

    await page.waitForTimeout(
      5000
    );

    let body =
      await page
        .locator("body")
        .innerText()
        .catch(() => "");

    let block =
      detectBlockState(body);

    if (block.status) {
      return {
        ...block,
        results: [],
      };
    }

    await expandResults(
      page
    );

    body =
      await page
        .locator("body")
        .innerText()
        .catch(() => "");

    block =
      detectBlockState(body);

    if (block.status) {
      return {
        ...block,
        results: [],
      };
    }

    const parsed =
      await parseAdvertisers(
        page,
        seed
      );

    debugDomainSearch(
      seed,
      country,
      page.url(),
      parsed.advertisers,
      parsed.diagnostics
    );

    const results:
      DiscoveryResult[] =
      parsed.advertisers.map(
        advertiser => ({
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
      results.length === 0
    ) {
      return {
        status:
          "manual_required",

        message:
          "DOMAIN_SEARCH loaded but no valid advertiser records were parsed. " +
          `seed=${seed}; url=${page.url()}. ` +
          "Check Railway SPY ADS DEBUG logs.",

        results: [],
      };
    }

    return {
      status:
        "completed",

      message:
        `DOMAIN_SEARCH completed. ` +
        `Found ${results.length} valid advertiser(s) for ${seed}.`,

      results,
    };
  } catch (error) {
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
