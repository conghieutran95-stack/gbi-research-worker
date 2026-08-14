import crypto from "node:crypto";
import express from "express";
import cors from "cors";
import { z } from "zod";
import { runGoogleAdsTransparency } from "./workers/google-transparency.js";
import type { DiscoveryJob } from "./types/discovery.js";

const app=express();
app.use(cors());
app.use(express.json({limit:"1mb"}));

const port=Number(process.env.PORT||3000);
const apiKey=process.env.WORKER_API_KEY||"";
const jobs=new Map<string,DiscoveryJob>();

function auth(req:express.Request,res:express.Response,next:express.NextFunction){
  if(!apiKey) return next();
  if(req.header("x-api-key")!==apiKey) return res.status(401).json({error:"Unauthorized"});
  next();
}

app.get("/health",(_req,res)=>res.json({ok:true,service:"gbi-research-worker",version:"0.1.0",time:new Date().toISOString()}));

app.post("/jobs",auth,(req,res)=>{
  const schema=z.object({type:z.literal("google_ads_transparency"),seed:z.string().min(2).max(500),country:z.string().min(2).max(20).optional()});
  const parsed=schema.safeParse(req.body);
  if(!parsed.success) return res.status(400).json({error:parsed.error.flatten()});

  const id=crypto.randomUUID();
  const job:DiscoveryJob={id,type:parsed.data.type,seed:parsed.data.seed,country:parsed.data.country,status:"queued",created_at:new Date().toISOString(),results:[]};
  jobs.set(id,job);
  res.status(202).json({id,status:job.status});

  queueMicrotask(async()=>{
    job.status="running";
    job.started_at=new Date().toISOString();
    const out=await runGoogleAdsTransparency(job.seed,job.country);
    job.status=out.status; job.message=out.message; job.results=out.results; job.finished_at=new Date().toISOString();
  });
});

app.get("/jobs/:id",auth,(req,res)=>{
  const job=jobs.get(req.params.id);
  if(!job) return res.status(404).json({error:"Job not found"});
  res.json(job);
});

app.get("/jobs",auth,(_req,res)=>res.json([...jobs.values()].sort((a,b)=>b.created_at.localeCompare(a.created_at))));

app.listen(port,"0.0.0.0",()=>console.log(`GBI Research Worker listening on :${port}`));
