import { chromium } from "playwright";

export type ImageDomainResolution = {
  imageUrl: string;
  domain?: string;
  landingUrl?: string;
  finalUrl?: string;
  success: boolean;
  error?: string;
};

/**
 * Resolve destination domain from a Google Ads Transparency creative/image.
 *
 * Important:
 * - imageUrl itself is normally a Google-hosted asset and is NOT the advertiser domain.
 * - We use the creative/ad page when available, inspect links/network/navigation,
 *   and return only external destination domains.
 */
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
      viewport: { width: 1440, height: 1200 },
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    });

    const page = await context.newPage();

    const candidates = new Set<string>();

    const addCandidate = (value?: string | null) => {
      if (!value) return;

      try {
        const url = new URL(value);

        if (!["http:", "https:"].includes(url.protocol)) return;

        const host = url.hostname.toLowerCase().replace(/^www\./, "");

        const blockedHosts = [
          "google.com",
          "www.google.com",
          "adstransparency.google.com",
          "googlesyndication.com",
          "tpc.googlesyndication.com",
          "googleusercontent.com",
          "gstatic.com",
          "doubleclick.net",
          "youtube.com",
          "youtu.be",
        ];

        if (
          blockedHosts.some(
            (blocked) => host === blocked || host.endsWith(`.${blocked}`)
          )
        ) {
          return;
        }

        candidates.add(url.toString());
      } catch {
        // Ignore invalid URLs.
      }
    };

    page.on("request", (request) => {
      const url = request.url();

      if (
        request.isNavigationRequest() ||
        request.resourceType() === "document"
      ) {
        addCandidate(url);
      }
    });

    page.on("response", async (response) => {
      const headers = response.headers();

      if (headers.location) {
        try {
          const location = new URL(
            headers.location,
            response.url()
          ).toString();

          addCandidate(location);
        } catch {
          // Ignore malformed redirect.
        }
      }
    });

    const targetUrl = adLibraryUrl || imageUrl;

    await page.goto(targetUrl, {
      waitUntil: "domcontentloaded",
      timeout: 45000,
    });

    await page.waitForTimeout(2500);

    // Collect all hrefs exposed by the creative page.
    const hrefs = await page
      .locator("a[href]")
      .evaluateAll((elements) =>
        elements
          .map((el) => (el as HTMLAnchorElement).href)
          .filter(Boolean)
      )
      .catch(() => [] as string[]);

    for (const href of hrefs) {
      addCandidate(href);
    }

    // Search page HTML for embedded destination URLs.
    const html = await page.content().catch(() => "");

    const urlMatches =
      html.match(/https?:\/\/[^\s"'<>\\]+/gi) || [];

    for (const url of urlMatches) {
      const cleaned = url
        .replace(/&amp;/g, "&")
        .replace(/\\u0026/g, "&")
        .replace(/\\\//g, "/");

      addCandidate(cleaned);
    }

    // Try visible links/buttons that may represent advertiser destination.
    const clickableSelectors = [
      'a[target="_blank"]',
      'a[rel*="noopener"]',
      'a[aria-label*="Visit" i]',
      'a[aria-label*="website" i]',
      'a[aria-label*="advertiser" i]',
    ];

    for (const selector of clickableSelectors) {
      const elements = page.locator(selector);
      const count = Math.min(await elements.count().catch(() => 0), 20);

      for (let i = 0; i < count; i++) {
        const href = await elements
          .nth(i)
          .getAttribute("href")
          .catch(() => null);

        if (href) {
          try {
            addCandidate(new URL(href, page.url()).toString());
          } catch {
            // Ignore.
          }
        }
      }
    }

    const candidateList = [...candidates];

    if (!candidateList.length) {
      result.error = "No external destination URL found";
      return result;
    }

    // Prefer first valid external candidate.
    const landingUrl = candidateList[0];

    let finalUrl = landingUrl;

    // Follow advertiser redirects to obtain final destination.
    try {
      const destinationPage = await context.newPage();

      await destinationPage.goto(landingUrl, {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });

      await destinationPage.waitForTimeout(1000);

      finalUrl = destinationPage.url() || landingUrl;

      await destinationPage.close();
    } catch {
      finalUrl = landingUrl;
    }

    const finalParsed = new URL(finalUrl);

    result.domain = finalParsed.hostname
      .toLowerCase()
      .replace(/^www\./, "");

    result.landingUrl = landingUrl;
    result.finalUrl = finalUrl;
    result.success = Boolean(result.domain);

    return result;
  } catch (error) {
    result.error =
      error instanceof Error ? error.message : String(error);

    return result;
  } finally {
    if (browser) {
      await browser.close().catch(() => undefined);
    }
  }
}

/**
 * Resolve multiple creatives with controlled concurrency.
 */
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
        Math.min(concurrency, queue.length || 1)
      ),
    },
    async () => {
      while (queue.length) {
        const item = queue.shift();

        if (!item) break;

        const result = await resolveDomainFromImage(
          item.imageUrl,
          item.adLibraryUrl
        );

        results.push(result);
      }
    }
  );

  await Promise.all(workers);

  return results;
}
