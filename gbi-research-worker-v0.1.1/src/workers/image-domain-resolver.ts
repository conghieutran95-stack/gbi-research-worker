import { createWorker } from "tesseract.js";
import sharp from "sharp";
import { getDomain } from "tldts";

export type ImageDomainResolution = {
  imageUrl: string;
  success: boolean;
  domain?: string;
  domains?: string[];
  ocrText?: string;
  confidence?: number;
  error?: string;
};

const BLOCKED_DOMAINS = [
  "google.com",
  "googleusercontent.com",
  "googlesyndication.com",
  "doubleclick.net",
  "gstatic.com",
  "youtube.com",
  "youtu.be",
  "googleapis.com",
  "googleadservices.com",
  "google-analytics.com",
  "googletagmanager.com",
];

function isBlockedDomain(domain: string): boolean {
  const d = domain.toLowerCase();

  return BLOCKED_DOMAINS.some(
    (blocked) =>
      d === blocked ||
      d.endsWith(`.${blocked}`)
  );
}

function cleanOCRText(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/[|]/g, " ")
    .trim();
}

function extractDomains(text: string): string[] {
  const cleaned = cleanOCRText(text);

  const found = new Set<string>();

  const regex =
    /\b(?:https?:\/\/)?(?:www\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}(?:\/[^\s]*)?/gi;

  const matches = cleaned.match(regex) || [];

  for (const match of matches) {
    const raw = match
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .replace(/[),.;:'"!?]+$/g, "");

    const domain = getDomain(raw, {
      allowPrivateDomains: true,
    });

    if (!domain) continue;

    const normalized = domain.toLowerCase();

    if (isBlockedDomain(normalized)) {
      continue;
    }

    found.add(normalized);
  }

  return [...found];
}

async function downloadImage(
  imageUrl: string
): Promise<Buffer> {
  const response = await fetch(imageUrl, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36",
      accept: "image/*,*/*;q=0.8",
    },
  });

  if (!response.ok) {
    throw new Error(
      `Image download failed: HTTP ${response.status}`
    );
  }

  const arrayBuffer =
    await response.arrayBuffer();

  return Buffer.from(arrayBuffer);
}

async function prepareImage(
  input: Buffer
): Promise<Buffer> {
  return sharp(input)
    .rotate()
    .resize({
      width: 2000,
      fit: "inside",
      withoutEnlargement: false,
    })
    .grayscale()
    .normalize()
    .sharpen()
    .png()
    .toBuffer();
}

export async function resolveDomainFromImage(
  imageUrl: string
): Promise<ImageDomainResolution> {
  let worker: Awaited<
    ReturnType<typeof createWorker>
  > | undefined;

  try {
    console.log(
      `[OCR] Downloading: ${imageUrl}`
    );

    const original =
      await downloadImage(imageUrl);

    const processed =
      await prepareImage(original);

    worker = await createWorker("eng");

    const recognition =
      await worker.recognize(processed);

    const text =
      recognition.data.text || "";

    const ocrConfidence =
      Number(
        recognition.data.confidence || 0
      );

    const domains =
      extractDomains(text);

    console.log(
      "[OCR RESULT]",
      {
        imageUrl,
        confidence:
          ocrConfidence,
        domains,
        text:
          text.slice(0, 500),
      }
    );

    if (!domains.length) {
      return {
        imageUrl,
        success: false,
        domains: [],
        ocrText: text,
        confidence:
          ocrConfidence,
        error:
          "No domain detected in image",
      };
    }

    return {
      imageUrl,
      success: true,
      domain: domains[0],
      domains,
      ocrText: text,
      confidence:
        ocrConfidence,
    };
  } catch (error) {
    console.error(
      "[OCR ERROR]",
      error
    );

    return {
      imageUrl,
      success: false,
      error:
        error instanceof Error
          ? error.message
          : String(error),
    };
  } finally {
    if (worker) {
      await worker
        .terminate()
        .catch(() => undefined);
    }
  }
}

export async function resolveDomainsFromImages(
  imageUrls: string[],
  concurrency = 2
): Promise<ImageDomainResolution[]> {
  const results:
    ImageDomainResolution[] = [];

  const queue = [...imageUrls];

  const workerCount =
    Math.max(
      1,
      Math.min(
        concurrency,
        queue.length || 1
      )
    );

  const workers =
    Array.from(
      { length: workerCount },
      async () => {
        while (queue.length) {
          const imageUrl =
            queue.shift();

          if (!imageUrl) {
            break;
          }

          const result =
            await resolveDomainFromImage(
              imageUrl
            );

          results.push(result);
        }
      }
    );

  await Promise.all(workers);

  return results;
}
