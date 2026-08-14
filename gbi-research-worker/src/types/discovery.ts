export type JobStatus = "queued"|"running"|"completed"|"failed"|"manual_required"|"blocked";
export type DiscoveryResult = {
  provider:"google_ads_transparency"; advertiser_name?:string; advertiser_id?:string;
  domain?:string; landing_url?:string; country?:string; source_url?:string;
  source_ref?:string; observed_at:string; raw_payload?:Record<string,unknown>;
};
export type DiscoveryJob = {
  id:string; type:"google_ads_transparency"; seed:string; country?:string;
  status:JobStatus; created_at:string; started_at?:string; finished_at?:string;
  message?:string; results:DiscoveryResult[];
};
