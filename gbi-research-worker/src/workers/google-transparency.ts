import { chromium, type Page } from "playwright";
import { extractHttpUrls, normalizeUrlToDomain } from "../lib/domain.js";
import type { DiscoveryResult, JobStatus } from "../types/discovery.js";

const BASE_URL = "https://adstransparency.google.com/";

function detectBlockState(text:string):{status?:JobStatus;message?:string}{
  const v=text.toLowerCase();
  if(v.includes("captcha")||v.includes("unusual traffic")||v.includes("verify you are human"))
    return {status:"manual_required",message:"Human verification/CAPTCHA detected."};
  if(v.includes("access denied")||v.includes("too many requests")||v.includes("rate limit"))
    return {status:"blocked",message:"Provider blocked or rate-limited this request."};
  return {};
}

async function trySearch(page:Page, seed:string):Promise<boolean>{
  const selectors=['input[type="search"]','input[placeholder*="Search" i]','input[aria-label*="Search" i]','input'];
  for(const selector of selectors){
    const loc=page.locator(selector).first();
    try{
      if(await loc.isVisible({timeout:1200})){
        await loc.fill(seed);
        await loc.press("Enter");
        return true;
      }
    }catch{}
  }
  return false;
}

function isGoogleInternal(url:string):boolean{
  try{
    const h=new URL(url).hostname.toLowerCase();
    return h.endsWith("google.com")||h.endsWith("gstatic.com")||h.endsWith("googleusercontent.com")||
      h.endsWith("googlesyndication.com")||h.endsWith("doubleclick.net");
  }catch{return true;}
}

export async function runGoogleAdsTransparency(seed:string,country?:string):Promise<{
  status:JobStatus; message?:string; results:DiscoveryResult[];
}>{
  const browser=await chromium.launch({headless:process.env.PLAYWRIGHT_HEADLESS!=="false"});
  const context=await browser.newContext({locale:"en-US",viewport:{width:1440,height:1000}});
  const page=await context.newPage();
  try{
    await page.goto(BASE_URL,{waitUntil:"domcontentloaded",timeout:45000});
    let body=await page.locator("body").innerText().catch(()=>"");
    let block=detectBlockState(body);
    if(block.status) return {...block,results:[]};

    const searched=await trySearch(page,seed);
    if(!searched) return {status:"manual_required",message:"Search control not found; UI may have changed.",results:[]};

    await page.waitForTimeout(4000);
    body=await page.locator("body").innerText().catch(()=>"");
    block=detectBlockState(body);
    if(block.status) return {...block,results:[]};

    const hrefs=await page.locator("a[href]").evaluateAll(els=>els.map(el=>(el as HTMLAnchorElement).href).filter(Boolean));
    const urls=[...new Set([...hrefs,...extractHttpUrls(body)])];

    const results:DiscoveryResult[]=[];
    const seen=new Set<string>();

    for(const url of urls){
      if(isGoogleInternal(url)) continue;
      const domain=normalizeUrlToDomain(url);
      if(!domain||seen.has(domain)) continue;
      seen.add(domain);
      results.push({
        provider:"google_ads_transparency",
        domain,
        landing_url:url,
        country,
        source_url:page.url(),
        source_ref:seed,
        observed_at:new Date().toISOString(),
        raw_payload:{seed,page_title:await page.title().catch(()=>undefined)}
      });
    }

    if(!results.length) return {
      status:"manual_required",
      message:"Search completed but no publicly rendered external landing domains were extractable.",
      results:[]
    };

    return {status:"completed",message:`Found ${results.length} unique external domain(s).`,results};
  }catch(e){
    return {status:"failed",message:e instanceof Error?e.message:"Unknown browser error",results:[]};
  }finally{
    await context.close().catch(()=>{});
    await browser.close().catch(()=>{});
  }
}
