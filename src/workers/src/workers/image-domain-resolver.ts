import sharp from "sharp";
import { createWorker, PSM, type Worker } from "tesseract.js";
import { getDomain } from "tldts";

export type ImageDomainResult = {
  imageUrl: string;
  ocrText: string;
  domains: string[];
  primaryDomain: string | null;
  confidence: number;
};

let workerPromise: Promise<Worker> | null = null;

const BLOCKED_DOMAINS = new Set([
  "google.com",
  "googleusercontent.com",
  "googlesyndication.com",
  "doubleclick.net",
  "gstatic.com",
  "adstransparency.google.com",
]);

async function getOcrWorker(): Promise<Worker> {
  if (!workerPromise) {
    workerPromise = (async () => {
      const worker = await createWorker("eng");

      await worker.setParameters({
        tessedit_pageseg_mode: PSM.SPARSE_TEXT,
        preserve_interword_spaces: "1",
      });

      return worker;
    })();
  }

  return workerPromise;
}

async function downloadImage(url: string): Promise<Buffer> {
  const res = await fetch(url, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/151 Safari/537.36",
      accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
    },
  });

  if (!res.ok) {
    throw new Error(`Image download failed: HTTP ${res.status}`);
  }

  const arr = await res.arrayBuffer();
  return Buffer.from(arr);
}

async function preprocessImage(input: Buffer): Promise<Buffer> {
  return sharp(input)
    .rotate()
    .resize({
      width: 1800,
      withoutEnlargement: false,
      fit: "inside",
    })
    .grayscale()
    .normalize()
    .sharpen()
    .png()
    .toBuffer();
}

function cleanCandidate(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/[),.;:'"!?]+$/g, "")
    .replace(/^[([{'"]+/g, "");
}

function extractDomainCandidates(text: string): string[] {
  const normalized = text
    .replace(/\s+/g, " ")
    .replace(/[|]/g, " ")
    .trim();

  const candidates = new Set<string>();

  const urlLikeRegex =
    /\b(?:https?:\/\/)?(?:www\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}(?:\/[^\s]*)?/gi;

  for (const match of normalized.matchAll(urlLikeRegex)) {
    const raw = cleanCandidate(match[0]);
    const domain = getDomain(raw, {
      allowPrivateDomains: true,
    });

    if (!domain) continue;

    const lower = domain.toLowerCase();

    if (BLOCKED_DOMAINS.has(lower)) continue;
    if (lower.endsWith(".google.com")) continue;
    if (lower.endsWith(".googleusercontent.com")) continue;
    if (lower.endsWith(".googlesyndication.com")) continue;

    candidates.add(lower);
  }

  return [...candidates];
}

function scoreDomain(domain: string, text: string): number {
  let score = 0.5;

  const lowerText = text.toLowerCase();

  if (lowerText.includes(domain)) score += 0.25;

  const withoutTld = domain.split(".")[0];

  if (withoutTld.length >= 4 && lowerText.includes(withoutTld)) {
    score += 0.15;
  }

  if (
    lowerText.includes(`www.${domain}`) ||
    lowerText.includes(`https://${domain}`) ||
    lowerText.includes(`http://${domain}`)
  ) {
    score += 0.1;
  }

  return Math.min(score, 0.99);
}

export async function resolveDomainFromImage(
  imageUrl: string
): Promise<ImageDomainResult> {
  const original = await downloadImage(imageUrl);
  const processed = await preprocessImage(original);

  const worker = await getOcrWorker();

  const {
    data: { text, confidence },
  } = await worker.recognize(processed);

  const domains = extractDomainCandidates(text);

  const ranked = domains
    .map((domain) => ({
      domain,
      score: scoreDomain(domain, text),
    }))
    .sort((a, b) => b.score - a.score);

  const primaryDomain = ranked[0]?.domain ?? null;

  const domainConfidence =
    ranked[0]?.score ??
    Math.max(0, Math.min(1, Number(confidence || 0) / 100));

  console.log("[IMAGE DOMAIN RESOLVER]", {
    imageUrl,
    primaryDomain,
    domains,
    ocrConfidence: confidence,
    domainConfidence,
  });

  return {
    imageUrl,
    ocrText: text,
    domains,
    primaryDomain,
    confidence: Number(domainConfidence.toFixed(3)),
  };
}

export async function resolveDomainsFromImages(
  imageUrls: string[],
  concurrency = 2
): Promise<ImageDomainResult[]> {
  const results: ImageDomainResult[] = [];

  for (let i = 0; i < imageUrls.length; i += concurrency) {
    const batch = imageUrls.slice(i, i + concurrency);

    const batchResults = await Promise.all(
      batch.map(async (url) => {
        try {
          return await resolveDomainFromImage(url);
        } catch (error) {
          console.error("[IMAGE DOMAIN RESOLVER ERROR]", url, error);

          return {
            imageUrl: url,
            ocrText: "",
            domains: [],
            primaryDomain: null,
            confidence: 0,
          };
        }
      })
    );

    results.push(...batchResults);
  }

  return results;
}
