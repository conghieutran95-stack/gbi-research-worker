import crypto from "node:crypto";
import express from "express";
import cors from "cors";
import { z } from "zod";

import { runGoogleAdsTransparency } from "./workers/google-transparency.js";
import {
  resolveDomainFromImage,
  resolveDomainsFromImages,
} from "./workers/image-domain-resolver.js";

import type { DiscoveryJob } from "./types/discovery.js";

const app = express();

app.use(cors());
app.use(express.json({ limit: "1mb" }));

const port = Number(process.env.PORT || 3000);
const apiKey = process.env.WORKER_API_KEY || "";

const jobs = new Map<string, DiscoveryJob>();

function auth(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
) {
  if (!apiKey) return next();

  if (req.header("x-api-key") !== apiKey) {
    return res.status(401).json({
      error: "Unauthorized",
    });
  }

  next();
}

/* =========================================================
   HEALTH
========================================================= */

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "gbi-research-worker",
    version: "0.1.4",
    image_domain_resolver: true,
    time: new Date().toISOString(),
  });
});

/* =========================================================
   GOOGLE ADS TRANSPARENCY JOBS
========================================================= */

app.post("/jobs", auth, (req, res) => {
  const schema = z.object({
    type: z.literal("google_ads_transparency"),
    seed: z.string().min(2).max(500),
    country: z.string().min(2).max(20).optional(),
  });

  const parsed = schema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({
      error: parsed.error.flatten(),
    });
  }

  const id = crypto.randomUUID();

  const job: DiscoveryJob = {
    id,
    type: parsed.data.type,
    seed: parsed.data.seed,
    country: parsed.data.country,
    status: "queued",
    created_at: new Date().toISOString(),
    results: [],
  };

  jobs.set(id, job);

  res.status(202).json({
    id,
    status: job.status,
  });

  queueMicrotask(async () => {
    job.status = "running";
    job.started_at = new Date().toISOString();

    try {
      const out = await runGoogleAdsTransparency(
        job.seed,
        job.country
      );

      job.status = out.status;
      job.message = out.message;
      job.results = out.results;
    } catch (error) {
      job.status = "failed";

      job.message =
        error instanceof Error
          ? error.message
          : "Unhandled worker error";
    } finally {
      job.finished_at = new Date().toISOString();
    }
  });
});

app.get("/jobs/:id", auth, (req, res) => {
  const job = jobs.get(req.params.id);

  if (!job) {
    return res.status(404).json({
      error: "Job not found",
    });
  }

  res.json(job);
});

app.get("/jobs", auth, (_req, res) => {
  const allJobs = [...jobs.values()].sort((a, b) =>
    b.created_at.localeCompare(a.created_at)
  );

  res.json(allJobs);
});

/* =========================================================
   IMAGE -> DOMAIN RESOLVER
========================================================= */

app.post("/resolve-image-domain", auth, async (req, res) => {
  try {
    const schema = z.object({
      imageUrl: z.string().url(),
    });

    const parsed = schema.safeParse(req.body);

    if (!parsed.success) {
      return res.status(400).json({
        error: parsed.error.flatten(),
      });
    }

    const result = await resolveDomainFromImage(
      parsed.data.imageUrl
    );

    return res.json({
      ok: true,
      result,
    });
  } catch (error) {
    console.error(
      "[RESOLVE IMAGE DOMAIN ERROR]",
      error
    );

    return res.status(500).json({
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : "Unknown image resolver error",
    });
  }
});

/* =========================================================
   BATCH IMAGE -> DOMAIN RESOLVER
========================================================= */

app.post("/resolve-image-domains", auth, async (req, res) => {
  try {
    const schema = z.object({
      imageUrls: z
        .array(z.string().url())
        .min(1)
        .max(100),

      concurrency: z
        .number()
        .int()
        .min(1)
        .max(5)
        .optional(),
    });

    const parsed = schema.safeParse(req.body);

    if (!parsed.success) {
      return res.status(400).json({
        error: parsed.error.flatten(),
      });
    }

    const results = await resolveDomainsFromImages(
      parsed.data.imageUrls,
      parsed.data.concurrency ?? 2
    );

    const resolved = results.filter(
      (item) => item.primaryDomain
    );

    return res.json({
      ok: true,
      total: results.length,
      resolved: resolved.length,
      unresolved: results.length - resolved.length,
      success_rate:
        results.length > 0
          ? Number(
              (
                (resolved.length / results.length) *
                100
              ).toFixed(2)
            )
          : 0,
      results,
    });
  } catch (error) {
    console.error(
      "[RESOLVE IMAGE DOMAINS ERROR]",
      error
    );

    return res.status(500).json({
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : "Unknown image resolver error",
    });
  }
});

/* =========================================================
   ERROR HANDLING
========================================================= */

process.on("unhandledRejection", (reason) => {
  console.error(
    "[UNHANDLED REJECTION]",
    reason
  );
});

process.on("uncaughtException", (error) => {
  console.error(
    "[UNCAUGHT EXCEPTION]",
    error
  );
});

/* =========================================================
   START SERVER
========================================================= */

app.listen(port, "0.0.0.0", () => {
  console.log(
    `GBI Research Worker v0.1.4 listening on :${port} | image-resolver=true`
  );
});
