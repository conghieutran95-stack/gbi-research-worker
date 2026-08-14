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

type FirstSearchCapture = {
  request: Request;
  response: Response;
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
    domainBrand(seedDomain);

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
   TIMESTAMP
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
   RESPONSE PARSER
========================================================= */

function parseGoogleResponseText(
  text: string
): any | undefined {
  let value =
    text.trim();

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
    return JSON.parse(value);
  } catch {}

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
   CREATIVE EXTRACTION
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

  if (
    advertiserId &&
    advertiserId.startsWith("AR") &&
    creativeId &&
    creativeId.startsWith("CR") &&
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
    of Object.values(value)
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

   Confirmed from live SearchCreatives:

   page 2 request:
   f.req["4"] = pagination token
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
   * SearchCreatives response has the
   * continuation token under field "2".
   *
   * Avoid AR/CR identifiers.
   */
  const direct =
    data["2"];

  if (
    typeof direct ===
      "string" &&
    direct.length >= 20 &&
    !direct.startsWith("AR") &&
    !direct.startsWith("CR")
  ) {
    return direct;
  }

  /*
   * Defensive fallback:
   * find opaque token near shallow levels.
   */
  const queue: Array<{
    value: any;
    depth: number;
  }> = [
    {
      value: data,
      depth: 0,
    },
  ];

  while (
    queue.length
  ) {
    const current =
      queue.shift()!;

    if (
      current.depth > 3
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
        child.length >= 30 &&
        !child.startsWith("AR") &&
        !child.startsWith("CR")
      ) {
        return child;
      }

      if (
        child &&
        typeof child ===
          "object"
      ) {
        queue.push({
          value: child,
          depth:
            current.depth + 1,
        });
      }
    }
  }

  return undefined;
}

/* =========================================================
   INITIAL REQUEST CAPTURE
========================================================= */

async function captureInitialSearch(
  context: BrowserContext,
  seed: string,
  region: string
): Promise<FirstSearchCapture> {
  const page =
    await context.newPage();

  const requestPromise =
    page.waitForRequest(
      request =>
        request.method() ===
          "POST" &&
        request
          .url()
          .includes(
            SEARCH_CREATIVES_PATH
          ),
      {
        timeout:
          45000,
      }
    );

  const responsePromise =
    page.waitForResponse(
      response =>
        response
          .url()
          .includes(
            SEARCH_CREATIVES_PATH
          ) &&
        response.status() ===
          200,
      {
        timeout:
          45000,
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

  /*
   * Keep user's required format.
   */
  params.set(
    "format",
    "TEXT"
  );

  const url =
    `${BASE_URL}?${params.toString()}`;

  console.log(
    "[SPY ADS V0.5] Opening:",
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

  const request =
    await requestPromise;

  const response =
    await responsePromise;

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
    throw new Error(
      block.message ||
      "Google blocked request."
    );
  }

  return {
    request,
    response,
  };
}

/* =========================================================
   INITIAL f.req
========================================================= */

function parseInitialPayload(
  request: Request
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
    form.get("f.req");

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

   DO NOT hardcode:
   - cookies
   - SID
   - SAPISID
   - XSRF

   We copy current browser request headers.
========================================================= */

async function buildReplayHeaders(
  request: Request
): Promise<Record<string, string>> {
  const original =
    await request.allHeaders();

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
    Record<string, string> =
    {};

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
   DIRECT RPC PAGE REQUEST
========================================================= */

async function requestPage(
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
  const payload =
    JSON.parse(
      JSON.stringify(
        basePayload
      )
    );

  /*
   * Confirmed from user's PAGE 2 cURL.
   */
  if (
    token
  ) {
    payload["4"] =
      token;
  } else {
    delete payload["4"];
  }

  const body =
    new URLSearchParams();

  body.set(
    "f.req",
    JSON.stringify(
      payload
    )
  );

  const response =
    await context
      .request
      .post(
        endpoint,
        {
          headers,

          data:
            body.toString(),
        }
      );

  const text =
    await response.text();

  if (
    !response.ok()
  ) {
    throw new Error(
      `SearchCreatives HTTP ${response.status()}: ${text.slice(
        0,
        500
      )}`
    );
  }

  const data =
    parseGoogleResponseText(
      text
    );

  if (
    !data
  ) {
    throw new Error(
      "Unable to parse SearchCreatives RPC response."
    );
  }

  return {
    response,
    data,
    text,
  };
}

/* =========================================================
   GROUP ADVERTISERS
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
      normalizeDomain(
        creative.domain
      ) !==
      normalizedSeed
    ) {
      continue;
    }

    const current =
      map.get(
        creative.advertiser_id
      );

    if (
      current
    ) {
      current
        .creativeIds
        .add(
          creative.creative_id
        );

      if (
        creative.first_seen
      ) {
        current.dates.push(
          creative.first_seen
        );
      }

      if (
        creative.last_seen
      ) {
        current.dates.push(
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
      creative.advertiser_id,
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
        classification.expand,

      confidence:
        classification.confidence,
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
   MAIN V0.5
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

  const creatives:
    CapturedCreative[] =
    [];

  const seenCreativeIds =
    new Set<string>();

  const seenTokens =
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

    /*
     * Let Google's own frontend create:
     * cookies + XSRF + request payload.
     */
    const initial =
      await captureInitialSearch(
        context,
        seed,
        region
      );

    const endpoint =
      initial.request.url();

    const payload =
      parseInitialPayload(
        initial.request
      );

    const replayHeaders =
      await buildReplayHeaders(
        initial.request
      );

    /*
     * PAGE 1
     */
    const page1Text =
      await initial.response.text();

    const page1Data =
      parseGoogleResponseText(
        page1Text
      );

    if (
      !page1Data
    ) {
      throw new Error(
        "Unable to parse PAGE 1."
      );
    }

    extractCreativesRecursive(
      page1Data,
      creatives,
      seenCreativeIds
    );

    let token =
      extractNextPageToken(
        page1Data
      );

    console.log(
      "[SPY ADS V0.5] PAGE 1:",
      creatives.length,
      "unique creatives"
    );

    /*
     * PAGE 2 -> N
     */
    let pagesLoaded =
      1;

    while (
      token &&
      pagesLoaded <
        MAX_PAGES
    ) {
      if (
        seenTokens.has(
          token
        )
      ) {
        console.log(
          "[SPY ADS V0.5] Repeated pagination token. Stop."
        );

        break;
      }

      seenTokens.add(
        token
      );

      const before =
        creatives.length;

      const next =
        await requestPage(
          context,
          endpoint,
          replayHeaders,
          payload,
          token
        );

      extractCreativesRecursive(
        next.data,
        creatives,
        seenCreativeIds
      );

      pagesLoaded += 1;

      const added =
        creatives.length -
        before;

      console.log(
        `[SPY ADS V0.5] PAGE ${pagesLoaded}: +${added}, total=${creatives.length}`
      );

      const nextToken =
        extractNextPageToken(
          next.data
        );

      /*
       * No continuation token means finished.
       */
      if (
        !nextToken
      ) {
        console.log(
          "[SPY ADS V0.5] No next token. Finished."
        );

        break;
      }

      token =
        nextToken;

      /*
       * Avoid hammering Google.
       */
      await new Promise(
        resolve =>
          setTimeout(
            resolve,
            500
          )
      );
    }

    const advertisers =
      buildAdvertiserSummaries(
        creatives,
        seed
      );

    console.log(
      "========== SPY ADS V0.5 =========="
    );

    console.log(
      "DOMAIN:",
      seed
    );

    console.log(
      "PAGES LOADED:",
      pagesLoaded
    );

    console.log(
      "UNIQUE CREATIVES:",
      creatives.length
    );

    console.log(
      "ADVERTISERS:",
      advertisers.length
    );

    console.log(
      JSON.stringify(
        advertisers,
        null,
        2
      )
    );

    console.log(
      "========== END V0.5 =========="
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
              "DOMAIN_SEARCH_RPC_V05",

            seed_domain:
              seed,

            requested_format:
              "TEXT",

            pages_loaded:
              pagesLoaded,

            total_unique_creatives:
              creatives.length,

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
          },
        })
      );

    if (
      creatives.length ===
      0
    ) {
      return {
        status:
          "manual_required",

        message:
          "SearchCreatives returned no creative records.",

        results: [],
      };
    }

    return {
      status:
        "completed",

      message:
        `V0.5 completed. ` +
        `${pagesLoaded} page(s), ` +
        `${creatives.length} unique creative(s), ` +
        `${advertisers.length} advertiser(s) for ${seed}.`,

      results,
    };
  } catch (
    error
  ) {
    console.error(
      "[SPY ADS V0.5 ERROR]",
      error
    );

    return {
      status:
        "failed",

      message:
        error instanceof Error
          ? error.stack ||
            error.message
          : "Unknown V0.5 error",

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
