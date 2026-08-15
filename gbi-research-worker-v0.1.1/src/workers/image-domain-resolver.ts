import { chromium } from "playwright";

export type ImageDomainResolution = {
  imageUrl: string;
  domain?: string;
  landingUrl?: string;
  finalUrl?: string;
  success: boolean;
  confidence?: number;
  candidates?: Array<{
    url: string;
    domain: string;
    score: number;
  }>;
  error?: string;
};

type Candidate = {
  url: string;
  domain: string;
  score: number;
};

const BLOCKED_ROOTS = [
  "google.com",
  "googleusercontent.com",
  "googlesyndication.com",
  "gstatic.com",
  "doubleclick.net",
  "youtube.com",
  "youtu.be",
  "googleapis.com",
  "googleadservices.com",
  "google-analytics.com",
  "googletagmanager.com",
  "googlevideo.com",
  "gvt1.com",
  "gvt2.com",
  "google",
];

function normalizeHost(hostname: string): string {
  return hostname.toLowerCase().replace(/^www\./, "");
}

function isBlockedHost(host: string): boolean {
  const normalized = normalizeHost(host);

  if (normalized === "safety.google") return true;
  if (normalized.endsWith(".google")) return true;

  return BLOCKED_ROOTS.some(
    (blocked) =>
      normalized === blocked ||
      normalized.endsWith(`.${blocked}`)
  );
}

function parseCandidate(value?: string | null): Candidate | null {
  if (!value) return null;

  try {
    const url = new URL(value);

    if (!["http:", "https:"].includes(url.protocol)) {
      return null;
    }

    const domain = normalizeHost(url.hostname);

    if (!domain || isBlockedHost(domain)) {
      return null;
    }

    return {
      url: url.toString(),
      domain,
      score: 0,
    };
  } catch {
    return null;
  }
}

function scoreCandidate(candidate: Candidate): number {
  let score = 0;

  const url = candidate.url.toLowerCase();
  const domain = candidate.domain.toLowerCase();

  // Prefer commercial / landing-page looking URLs.
  if (url.includes("utm_")) score += 20;
  if (url.includes("gclid=")) score += 20;
  if (url.includes("campaign")) score += 10;
  if (url.includes("offer")) score += 10;
  if (url.includes("shop")) score += 8;
  if (url.includes("product")) score += 8;
  if (url.includes("collections")) score += 6;

  // Prefer shorter, cleaner domains.
  const labels = domain.split(".").length;

  if (labels === 2) score += 15;
  if (labels === 3) score += 8;

  // Penalize obvious policy/docs/account links.
  const badWords = [
    "privacy",
    "policy",
    "terms",
    "support",
    "help",
    "account",
    "login",
    "signin",
    "docs",
    "developer",
    "about",
    "careers",
    "legal",
    "security",
    "safety",
  ];

  for (const word of badWords) {
    if (url.includes(word)) {
      score -= 20;
    }
  }

  return score;
}

export async function resolveDomainFromImage(
  imageUrl: string,
  adLibraryUrl?: string
): Promise<ImageDomainResolution> {
  const result: ImageDomainResolution = {
    imageUrl,
    success: false,
  };

  let browser;

  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
      ],
    });

    const context = await browser.newContext({
      viewport: {
        width: 1440,
        height: 1200,
      },
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
        "AppleWebKit/537.36 (KHTML, like Gecko) " +
        "Chrome/131.0.0.0 Safari/537.36",
    });

    const page = await context.newPage();

    const candidateMap = new Map<string, Candidate>();

    const addCandidate = (
      value?: string | null,
      bonus = 0
    ) => {
      const parsed = parseCandidate(value);

      if (!parsed) return;

      const score = scoreCandidate(parsed) + bonus;

      const existing = candidateMap.get(parsed.url);

      if (!existing || score > existing.score) {
        candidateMap.set(parsed.url, {
          ...parsed,
          score,
        });
      }
    };

    page.on("request", (request) => {
      const url = request.url();

      if (request.isNavigationRequest()) {
        addCandidate(url, 25);
        return;
      }

      if (request.resourceType() === "document") {
        addCandidate(url, 15);
      }
    });

    page.on("response", async (response) => {
      const headers = response.headers();

      if (!headers.location) return;

      try {
        const resolved = new URL(
          headers.location,
          response.url()
        ).toString();

        addCandidate(resolved, 20);
      } catch {
        // ignore
      }
    });

    const targetUrl = adLibraryUrl || imageUrl;

    await page.goto(targetUrl, {
      waitUntil: "domcontentloaded",
      timeout: 45000,
    });

    await page.waitForTimeout(3500);

    /*
     * Links visible on the page.
     */
    const hrefs = await page
      .locator("a[href]")
      .evaluateAll((elements) =>
        elements
          .map(
            (el) =>
              (el as HTMLAnchorElement).href
          )
          .filter(Boolean)
      )
      .catch(() => [] as string[]);

    for (const href of hrefs) {
      addCandidate(href, 5);
    }

    /*
     * Prefer links that look like CTA / advertiser visit links.
     */
    const strongSelectors = [
      'a[target="_blank"]',
      'a[rel*="noopener"]',
      'a[aria-label*="visit" i]',
      'a[aria-label*="website" i]',
      'a[aria-label*="advertiser" i]',
      'a[href*="url="]',
      'a[href*="redirect"]',
      'a[href*="destination"]',
    ];

    for (const selector of strongSelectors) {
      const elements = page.locator(selector);

      const count = Math.min(
        await elements.count().catch(() => 0),
        30
      );

      for (let i = 0; i < count; i++) {
        const href = await elements
          .nth(i)
          .getAttribute("href")
          .catch(() => null);

        if (!href) continue;

        try {
          addCandidate(
            new URL(href, page.url()).toString(),
            30
          );
        } catch {
          // ignore
        }
      }
    }

    /*
     * Search raw HTML for embedded external URLs.
     */
    const html = await page.content().catch(() => "");

    const urlMatches =
      html.match(/https?:\/\/[^\s"'<>\\]+/gi) || [];

    for (const raw of urlMatches) {
      const cleaned = raw
        .replace(/&amp;/g, "&")
        .replace(/\\u0026/g, "&")
        .replace(/\\\//g, "/");

      addCandidate(cleaned, 3);
    }

    const candidates = [...candidateMap.values()]
      .sort((a, b) => b.score - a.score);

    result.candidates = candidates.slice(0, 10);

    if (!candidates.length) {
      result.error =
        "No valid external advertiser destination found";

      return result;
    }

    const best = candidates[0];

    /*
     * Conservative threshold:
     * if candidate is weak, do not save garbage.
     */
    if (best.score < 10) {
      result.error =
        "External URLs found, but confidence too low";

      return result;
    }

    let finalUrl = best.url;

    /*
     * Follow redirect chain.
     */
    try {
      const destinationPage = await context.newPage();

      await destinationPage.goto(best.url, {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });

      await destinationPage.waitForTimeout(1200);

      const resolvedUrl =
        destinationPage.url() || best.url;

      const parsedFinal = parseCandidate(resolvedUrl);

      if (parsedFinal) {
        finalUrl = resolvedUrl;
      }

      await destinationPage.close();
    } catch {
      finalUrl = best.url;
    }

    const finalParsed = parseCandidate(finalUrl);

    if (!finalParsed) {
      result.error =
        "Final URL resolved to blocked or invalid domain";

      return result;
    }

    result.domain = finalParsed.domain;
    result.landingUrl = best.url;
    result.finalUrl = finalUrl;

    result.confidence = Math.min(
      0.99,
      Math.max(
        0.1,
        0.5 + best.score / 100
      )
    );

    result.success = true;

    return result;
  } catch (error) {
    result.error =
      error instanceof Error
        ? error.message
        : String(error);

    return result;
  } finally {
    if (browser) {
      await browser
        .close()
        .catch(() => undefined);
    }
  }
}

export async function resolveDomainsFromImages(
  items: Array<{
    imageUrl: string;
    adLibraryUrl?: string;
  }>,
  concurrency = 2
): Promise<ImageDomainResolution[]> {
  const results: ImageDomainResolution[] = [];

  const queue = [...items];

  const workers = Array.from(
    {
      length: Math.max(
        1,
        Math.min(
          concurrency,
          queue.length || 1
        )
      ),
    },
    async () => {
      while (queue.length) {
        const item = queue.shift();

        if (!item) break;

        const resolved =
          await resolveDomainFromImage(
            item.imageUrl,
            item.adLibraryUrl
          );

        results.push(resolved);
      }
    }
  );

  await Promise.all(workers);

  return results;
}
