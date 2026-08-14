export function normalizeUrlToDomain(value:string):string|undefined{
  let s=value.trim(); if(!s) return;
  if(!/^https?:\/\//i.test(s)){ if(!s.includes(".")) return; s="https://"+s; }
  try{
    const u=new URL(s); let h=u.hostname.toLowerCase().replace(/^www\./,"");
    const p=h.split(".").filter(Boolean); if(p.length<2) return;
    const multipart=new Set(["co.uk","com.au","co.nz","co.jp","co.in"]);
    const last2=p.slice(-2).join(".");
    return multipart.has(last2)&&p.length>=3?p.slice(-3).join("."):p.slice(-2).join(".");
  }catch{return;}
}
export function extractHttpUrls(text:string):string[]{
  return [...new Set((text.match(/https?:\/\/[^\s"'<>()[\]{}]+/gi)||[]).map(x=>x.replace(/[),.;]+$/,"")))];
}
