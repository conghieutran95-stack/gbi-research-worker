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

type CandidateLink = {
  href: string;
  text: string;
  ariaLabel?: string;
  parentText?: string;
  tag?: string;
  domain?: string;
};

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

    try {
      await el.fill(seed, { timeout: 3000 });
    } catch {
      await el.press("Control+A").catch(() => {});
      await el.type(seed, { delay: 30 }).catch(() => {});
    }

    await el.press("Enter", { timeout: 3000 }).catch(() => {});

    return true;
  } catch {
    return false;
  }
}

async function trySearch(
  page: Page,
  seed: string
): Promise<{
  success: boolean;
  strategy?: string;
  diagnostics?: Record<string, unknown>;
}> {
  await page.waitForTimeout(2500);

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

      const combined =
        `${type} ${placeholder} ${aria}`.toLowerCase();

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

  return {
    success: false,
    diagnostics: {
      url: page.url(),
      title: await page.title().catch(() => ""),
    },
  };
}

function isGoogleNoise(url: string): boolean {
  try {
    const h = new URL(url).hostname.toLowerCase();

    const noiseHosts = [
      "google.com",
      "www.google.com",
      "support.google.com",
      "safety.google",
      "blog.google",
      "youtube.com",
      "www.youtube.com",
      "gstatic.com",
      "googleusercontent.com",
      "googlesyndication.com",
      "doubleclick.net",
      "accounts.google.com",
      "policies.google.com",
    ];

    return noiseHosts.some(
      (host) => h === host || h.endsWith(`.${host}`)
    );
  } catch {
    return true;
  }
}

async function collectCandidateLinks(
  page: Page
): Promise<CandidateLink[]> {
  const raw = await page
    .locator("a[href]")
    .evaluateAll((els) => {
      return els.slice(0, 300).map((el) => {
        const a = el as HTMLAnchorElement;

        const parent =
          a.closest(
            'article, [role="listitem"], [role="row"], [role="link"], mat-card, div'
          ) || a.parentElement;

        return {
          href: a.href || "",
          text: (a.innerText || a.textContent || "")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 500),

          ariaLabel: (a.getAttribute("aria-label") || "")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 300),

          parentText: (parent?.textContent || "")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 1200),

          tag: parent?.tagName || "",
        };
      });
    })
    .catch(() => []);

  const result: CandidateLink[] = [];

  for (const item of raw) {
    if (!item.href) continue;

    let domain: string | undefined;

    try {
      domain = normalizeUrlToDomain(item.href);
    } catch {}

    result.push({
      ...item,
      domain,
    });
  }

  return result;
}

function scoreCandidate(
  candidate: CandidateLink,
  seed: string
): number {
  let score = 0;

  const haystack = [
    candidate.href,
    candidate.text,
    candidate.ariaLabel,
    candidate.parentText,
  ]
    .join(" ")
    .toLowerCase();

  const normalizedSeed =
    normalizeUrlToDomain(seed)?.toLowerCase() ||
    seed.toLowerCase();

  if (candidate.domain === normalizedSeed) {
    score += 100;
  }

  if (haystack.includes(normalizedSeed)) {
    score += 50;
  }

  if (
    haystack.includes("advertiser") ||
    haystack.includes("advertiser details")
  ) {
    score += 20;
  }

  if (
    haystack.includes("ad") ||
    haystack.includes("advertisement") ||
    haystack.includes("creative")
  ) {
    score += 10;
  }

  if (
    candidate.href.includes("/advertiser/") ||
    candidate.href.includes("advertiser?")
  ) {
    score += 40;
  }

  if (
    candidate.parentText &&
    candidate.parentText.length > 80
  ) {
    score += 5;
  }

  return score;
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
      headless:
        process.env.PLAYWRIGHT_HEADLESS !== "false",
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
          JSON.stringify(search.diagnostics),

        results: [],
      };
    }

    await page.waitForTimeout(7000);

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

    const candidates =
      await collectCandidateLinks(page);

    const scored = candidates
      .map((candidate) => ({
        ...candidate,
        score: scoreCandidate(candidate, seed),
      }))
      .sort((a, b) => b.score - a.score);

    /**
     * Only high-confidence domains become actual project results.
     * Everything else stays diagnostic only.
     */
    const strongCandidates = scored.filter(
      (candidate) =>
        candidate.score >= 50 &&
        candidate.domain &&
        !isGoogleNoise(candidate.href)
    );

    const results: DiscoveryResult[] = [];

    const seen = new Set<string>();

    for (const candidate of strongCandidates) {
      if (!candidate.domain) continue;

      if (seen.has(candidate.domain)) {
        continue;
      }

      seen.add(candidate.domain);

      results.push({
        provider:
          "google_ads_transparency",

        domain:
          candidate.domain,

        landing_url:
          candidate.href,

        country,

        source_url:
          page.url(),

        source_ref:
          seed,

        observed_at:
          new Date().toISOString(),

        raw_payload: {
          seed,

          search_strategy:
            search.strategy,

          candidate_score:
            candidate.score,

          anchor_text:
            candidate.text,

          aria_label:
            candidate.ariaLabel,

          parent_text:
            candidate.parentText,

          page_title:
            await page
              .title()
              .catch(() => undefined),
        },
      });
    }

    /**
     * If we do not yet have a trustworthy domain,
     * return DOM diagnostics instead of polluting database.
     */
    if (!results.length) {
      const diagnostics = scored
        .slice(0, 25)
        .map((item) => ({
          score: item.score,
          href: item.href,
          domain: item.domain,
          text: item.text,
          ariaLabel: item.ariaLabel,
          parentText: item.parentText,
        }));

      return {
        status: "manual_required",

        message:
          "Search succeeded but no high-confidence advertiser/project domain was identified. " +
          `strategy=${search.strategy}; ` +
          `url=${page.url()}; ` +
          `candidates=${JSON.stringify(diagnostics)}`,

        results: [],
      };
    }

    return {
      status: "completed",

      message:
        `Search succeeded via ${search.strategy}. ` +
        `Found ${results.length} high-confidence project domain(s).`,

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
