import {
  chromium,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
} from "playwright";

import {
  extractHttpUrls,
  normalizeUrlToDomain,
} from "../lib/domain.js";

import type {
  DiscoveryResult,
  JobStatus,
} from "../types/discovery.js";

const BASE_URL = "https://adstransparency.google.com/";

function detectBlockState(
  text: string
): { status?: JobStatus; message?: string } {
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
      message: "Provider blocked or rate-limited this request.",
    };
  }

  return {};
}

/**
 * Try a locator safely.
 * Returns true only when the element exists, is visible and seed was submitted.
 */
async function submitSearch(
  locator: Locator,
  seed: string
): Promise<boolean> {
  try {
    if ((await locator.count()) === 0) return false;

    const el = locator.first();

    if (!(await el.isVisible({ timeout: 1800 }))) {
      return false;
    }

    await el.click({ timeout: 3000 }).catch(() => {});

    // Standard input / textarea
    try {
      await el.fill(seed, { timeout: 3000 });
    } catch {
      // Some Google controls may behave differently.
      await el.press("Control+A").catch(() => {});
      await el.type(seed, { delay: 30 }).catch(() => {});
    }

    await el.press("Enter", { timeout: 3000 }).catch(() => {});

    return true;
  } catch {
    return false;
  }
}

/**
 * Find the Transparency Center search field using several strategies.
 *
 * Important:
 * - No CAPTCHA bypass.
 * - No hidden/private API interception.
 * - Only interacts with publicly rendered UI.
 */
async function trySearch(
  page: Page,
  seed: string
): Promise<{
  success: boolean;
  strategy?: string;
  diagnostics?: Record<string, unknown>;
}> {
  // Let Google client-side app hydrate.
  await page.waitForTimeout(2500);

  /**
   * Strategy 1:
   * Accessible textbox whose surrounding name matches the actual
   * current Google wording:
   * "Search by advertiser or website"
   */
  const roleTextbox = page.getByRole("textbox");

  const textboxCount = await roleTextbox.count().catch(() => 0);

  for (let i = 0; i < textboxCount; i++) {
    const textbox = roleTextbox.nth(i);

    try {
      if (!(await textbox.isVisible({ timeout: 800 }))) continue;

      const placeholder =
        (await textbox.getAttribute("placeholder").catch(() => null)) || "";

      const aria =
        (await textbox.getAttribute("aria-label").catch(() => null)) || "";

      const text = `${placeholder} ${aria}`.toLowerCase();

      if (
        text.includes("advertiser") ||
        text.includes("website") ||
        text.includes("search")
      ) {
        if (await submitSearch(textbox, seed)) {
          return {
            success: true,
            strategy: `role-textbox-${i}`,
          };
        }
      }
    } catch {}
  }

  /**
   * Strategy 2:
   * Exact / partial placeholder and ARIA strings.
   */
  const semanticCandidates: Locator[] = [
    page.getByPlaceholder(/search by advertiser or website/i),
    page.getByPlaceholder(/advertiser.*website/i),
    page.getByPlaceholder(/search/i),

    page.getByLabel(/search by advertiser or website/i),
    page.getByLabel(/advertiser.*website/i),
    page.getByLabel(/search/i),

    page.locator(
      'input[placeholder*="advertiser" i][placeholder*="website" i]'
    ),

    page.locator(
      'input[aria-label*="advertiser" i][aria-label*="website" i]'
    ),

    page.locator('input[type="search"]'),
  ];

  for (let i = 0; i < semanticCandidates.length; i++) {
    if (await submitSearch(semanticCandidates[i], seed)) {
      return {
        success: true,
        strategy: `semantic-${i}`,
      };
    }
  }

  /**
   * Strategy 3:
   * Inspect visible inputs, excluding obviously unrelated controls.
   */
  const inputs = page.locator(
    'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="file"])'
  );

  const inputCount = await inputs.count().catch(() => 0);

  for (let i = 0; i < inputCount; i++) {
    const input = inputs.nth(i);

    try {
      if (!(await input.isVisible({ timeout: 700 }))) continue;

      const type =
        (await input.getAttribute("type").catch(() => null)) || "";

      const placeholder =
        (await input.getAttribute("placeholder").catch(() => null)) || "";

      const aria =
        (await input.getAttribute("aria-label").catch(() => null)) || "";

      const autocomplete =
        (await input.getAttribute("autocomplete").catch(() => null)) || "";

      const combined =
        `${type} ${placeholder} ${aria} ${autocomplete}`.toLowerCase();

      // Skip likely auth fields.
      if (
        combined.includes("password") ||
        combined.includes("email") ||
        combined.includes("signin") ||
        combined.includes("sign in")
      ) {
        continue;
      }

      if (await submitSearch(input, seed)) {
        return {
          success: true,
          strategy: `generic-input-${i}`,
        };
      }
    } catch {}
  }

  /**
   * Strategy 4:
   * Some JS applications use textarea or contenteditable controls.
   */
  const alternateControls = [
    page.locator("textarea"),
    page.locator('[contenteditable="true"]'),
  ];

  for (let i = 0; i < alternateControls.length; i++) {
    const group = alternateControls[i];
    const count = await group.count().catch(() => 0);

    for (let j = 0; j < count; j++) {
      if (await submitSearch(group.nth(j), seed)) {
        return {
          success: true,
          strategy: `alternate-${i}-${j}`,
        };
      }
    }
  }

  /**
   * Return diagnostics so next failure tells us WHAT Railway actually saw,
   * instead of only saying "search not found".
   */
  const diagnostics = await page
    .evaluate(() => {
      const els = Array.from(
        document.querySelectorAll(
          'input, textarea, [contenteditable="true"], [role="textbox"]'
        )
      );

      return els.slice(0, 30).map((el: any) => ({
        tag: el.tagName,
        type: el.getAttribute?.("type"),
        placeholder: el.getAttribute?.("placeholder"),
        ariaLabel: el.getAttribute?.("aria-label"),
        role: el.getAttribute?.("role"),
        contentEditable: el.getAttribute?.("contenteditable"),
        visible:
          !!(
            el.offsetWidth ||
            el.offsetHeight ||
            el.getClientRects?.().length
          ),
      }));
    })
    .catch(() => []);

  return {
    success: false,
    diagnostics: {
      url: page.url(),
      title: await page.title().catch(() => ""),
      controls: diagnostics,
    },
  };
}

function isGoogleInternal(url: string): boolean {
  try {
    const h = new URL(url).hostname.toLowerCase();

    return (
      h.endsWith("google.com") ||
      h.endsWith("gstatic.com") ||
      h.endsWith("googleusercontent.com") ||
      h.endsWith("googlesyndication.com") ||
      h.endsWith("doubleclick.net")
    );
  } catch {
    return true;
  }
}

export async function runGoogleAdsTransparency(
  seed: string,
  country?: string
): Promise<{
  status: JobStatus;
  message?: string;
  results: DiscoveryResult[];
}> {
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;

  try {
    browser = await chromium.launch({
      headless: process.env.PLAYWRIGHT_HEADLESS !== "false",
    });

    context = await browser.newContext({
      locale: "en-US",

      viewport: {
        width: 1440,
        height: 1000,
      },

      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
        "AppleWebKit/537.36 (KHTML, like Gecko) " +
        "Chrome/131.0.0.0 Safari/537.36",
    });

    const page = await context.newPage();

    const startUrl = country
      ? `${BASE_URL}?region=${encodeURIComponent(country)}`
      : BASE_URL;

    await page.goto(startUrl, {
      waitUntil: "domcontentloaded",
      timeout: 45000,
    });

    // Allow SPA rendering.
    await page.waitForTimeout(3000);

    let body = await page
      .locator("body")
      .innerText()
      .catch(() => "");

    let block = detectBlockState(body);

    if (block.status) {
      return {
        ...block,
        results: [],
      };
    }

    const search = await trySearch(page, seed);

    if (!search.success) {
      return {
        status: "manual_required",

        message:
          "Search control not found. " +
          `URL=${page.url()} ` +
          `Diagnostics=${JSON.stringify(search.diagnostics)}`,

        results: [],
      };
    }

    // Wait for Google results/navigation to update.
    await Promise.race([
      page.waitForLoadState("networkidle", {
        timeout: 10000,
      }),
      page.waitForTimeout(6000),
    ]).catch(() => {});

    body = await page
      .locator("body")
      .innerText()
      .catch(() => "");

    block = detectBlockState(body);

    if (block.status) {
      return {
        ...block,
        results: [],
      };
    }

    /**
     * Public links currently rendered by Google page.
     */
    const hrefs = await page
      .locator("a[href]")
      .evaluateAll((els) =>
        els
          .map((el) => (el as HTMLAnchorElement).href)
          .filter(Boolean)
      )
      .catch(() => []);

    /**
     * Also collect plain HTTP URLs rendered as text.
     */
    const textUrls = extractHttpUrls(body);

    const urls = [
      ...new Set([
        ...hrefs,
        ...textUrls,
      ]),
    ];

    const results: DiscoveryResult[] = [];

    const seen = new Set<string>();

    for (const url of urls) {
      if (isGoogleInternal(url)) continue;

      const domain = normalizeUrlToDomain(url);

      if (!domain) continue;
      if (seen.has(domain)) continue;

      seen.add(domain);

      results.push({
        provider: "google_ads_transparency",

        domain,

        landing_url: url,

        country,

        source_url: page.url(),

        source_ref: seed,

        observed_at: new Date().toISOString(),

        raw_payload: {
          seed,

          search_strategy: search.strategy,

          page_title: await page
            .title()
            .catch(() => undefined),
        },
      });
    }

    if (!results.length) {
      /**
       * This does NOT mean search failed.
       *
       * Google may expose advertiser pages / creatives without rendering
       * final external landing URLs directly in the DOM.
       */
      return {
        status: "manual_required",

        message:
          "Google Ads Transparency search succeeded " +
          `using strategy "${search.strategy}", ` +
          "but no publicly rendered external landing domains were found. " +
          `Current URL: ${page.url()}`,

        results: [],
      };
    }

    return {
      status: "completed",

      message:
        `Search succeeded via ${search.strategy}. ` +
        `Found ${results.length} unique external domain(s).`,

      results,
    };
  } catch (e) {
    return {
      status: "failed",

      message:
        e instanceof Error
          ? e.stack || e.message
          : "Unknown browser error",

      results: [],
    };
  } finally {
    if (context) {
      await context.close().catch(() => {});
    }

    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}
