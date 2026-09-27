import { HttpSession, formBody } from "./http.mjs";
import { ProviderError, normalizeName, numberValue, isoDate, monthsAgoDate } from "../common.mjs";

const BASE = "https://rt.molit.go.kr";
const LANDING = `${BASE}/pt/xls/xls.do`;
const SIDO = `${BASE}/data/sido.do`, SGG = `${BASE}/data/sgg.do`, EMD = `${BASE}/data/emd.do`;
const COUNT = `${BASE}/pt/xls/ptXlsDownDataCheck.do`, CSV = `${BASE}/pt/xls/ptXlsCSVDown.do`;
const cache = { at: 0, sido: null, sgg: new Map(), emd: new Map() };
const TTL = 24 * 60 * 60 * 1000;

function headers() { return { referer: LANDING, "x-requested-with": "XMLHttpRequest" }; }
function parseJson(text, label) { try { return JSON.parse(text); } catch { throw new ProviderError("RTMS_BAD_RESPONSE", `${label} response was not JSON`, { sourceApi: label }); } }
async function startSession() { const s = new HttpSession({ userAgent: "korean-real-estate-mcp/0.1", maxBytes: 64_000_000 }); const r=await s.request(LANDING,{headers:{accept:"text/html,*/*"}}); if(!r.ok) throw new ProviderError("RTMS_HTTP",`RTMS landing HTTP ${r.status}`); return s; }
async function postJson(s,url,obj,label){ const r=await s.request(url,{method:"POST",headers:{...headers(),"content-type":"application/x-www-form-urlencoded"},body:formBody(obj),maxBytes:2_000_000}); if(!r.ok) throw new ProviderError("RTMS_HTTP",`${label} HTTP ${r.status}`,{sourceApi:url}); return parseJson(r.text,label); }

export async function listSido(s = null) {
  if (cache.sido && Date.now()-cache.at<TTL) return cache.sido;
  s ||= await startSession(); const data=await postJson(s,SIDO,{},"sido"); if(!Array.isArray(data)) throw new ProviderError("RTMS_CONTRACT","sido response is not a list"); cache.sido=data; cache.at=Date.now(); return data;
}
export async function listSgg(prefix, s = null) {
  if(cache.sgg.has(prefix)&&Date.now()-cache.at<TTL) return cache.sgg.get(prefix); s ||= await startSession(); const data=await postJson(s,SGG,{signguCode:prefix},"sgg"); if(!Array.isArray(data)) throw new ProviderError("RTMS_CONTRACT","sgg response is not a list"); cache.sgg.set(prefix,data); return data;
}
export async function listEmd(signguCode,s=null){ if(cache.emd.has(signguCode)&&Date.now()-cache.at<TTL) return cache.emd.get(signguCode); s ||=await startSession(); const data=await postJson(s,EMD,{signguCode},"emd"); if(!Array.isArray(data)) throw new ProviderError("RTMS_CONTRACT","emd response is not a list"); cache.emd.set(signguCode,data); return data; }

function tokens(q){ return String(q).replace(/[()]/g," ").split(/\s+/).filter(Boolean); }
export async function resolveRegion(query) {
  const q=String(query||"").trim(); if(!q) throw new ProviderError("INVALID_REGION","region query is required");
  const s=await startSession(); const sido=await listSido(s); const ts=tokens(q); let provinces=sido.filter(x=>q.includes(String(x.ctprvnNm||"")));
  if(!provinces.length) provinces=sido;
  const candidates=[];
  for(const p of provinces){ const pcode=String(p.signguCode||"").slice(0,2); if(!pcode) continue; const rows=await listSgg(pcode,s); for(const r of rows){ const name=String(r.signguNm||""); if(name && (q.includes(name)||ts.some(t=>t===name))) candidates.push({...r,ctprvnNm:p.ctprvnNm}); } if(candidates.length) break; }
  if(!candidates.length) throw new ProviderError("REGION_NOT_FOUND",`No RTMS region matched: ${q}`);
  if(candidates.length>1) throw new ProviderError("AMBIGUOUS_REGION",`Multiple regions matched: ${q}`,{candidates:candidates.slice(0,10)});
  const base=candidates[0]; const emds=await listEmd(String(base.signguCode),s); let emd=emds.find(x=>{const n=String(x.emdNm||""); return n&&q.includes(n);});
  const lawdCd=String(base.signguCode); const emdCode=emd?String(emd.emdCode):"00000";
  return { province:String(base.ctprvnNm||""), district:String(base.signguNm||""), dong:emd?String(emd.emdNm):null, lawd_cd:lawdCd, emd_code:emdCode, cortar_no:lawdCd+emdCode, canonical:[base.ctprvnNm,base.signguNm,emd?.emdNm].filter(Boolean).join(" ") };
}

export function parseCsv(text) {
  const rows=[]; let row=[],cell="",q=false;
  for(let i=0;i<text.length;i++){ const c=text[i]; if(q){ if(c==='"'&&text[i+1]==='"'){cell+='"';i++;} else if(c==='"') q=false; else cell+=c; } else { if(c==='"') q=true; else if(c===','){row.push(cell);cell="";} else if(c==='\n'){row.push(cell.replace(/\r$/, "")); rows.push(row); row=[];cell="";} else cell+=c; } }
  if(cell||row.length){row.push(cell);rows.push(row);} const hi=rows.findIndex(r=>String(r[0]||"").replace(/^\uFEFF/,"").trim()==="NO"); if(hi<0) throw new ProviderError("RTMS_CSV_CONTRACT","CSV header not found");
  const head=rows[hi].map((x,i)=>i===0?String(x).replace(/^\uFEFF/,"").trim():String(x).trim());
  return rows.slice(hi+1).filter(r=>r.some(x=>String(x).trim())).map(r=>Object.fromEntries(head.map((h,i)=>[h,String(r[i]??"").trim()])));
}
export function dedupeSourceRows(rows) {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const no = String(row?.["NO"] || "").trim();
    const key = no ? `NO:${no}` : `ROW:${JSON.stringify(row)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}
function form(region,{dealType="sale",fromDate,toDate}={}) { return {
  srhThingNo:"A",srhDelngSecd:dealType==="sale"?"1":"2",srhAddrGbn:"1",srhLfstsSecd:"1",sidoNm:region.province||"전체",sggNm:region.district||"전체",emdNm:region.dong||"전체",loadNm:"전체",areaNm:"전체",hsmpNm:"전체",mobileAt:"",
  srhFromDt:fromDate,srhToDt:toDate,srhNewRonSecd:"",srhSidoCd:region.lawd_cd.slice(0,2),srhSggCd:region.lawd_cd,srhEmdCd:region.dong?region.emd_code:"",srhLoadCd:"",srhHsmpCd:"",srhRoadNm:"",srhArea:"",srhLrArea:"",srhFromAmount:"",srhToAmount:""
}; }
function dateFromRow(r){ const ym=String(r["계약년월"]||""); const d=String(r["계약일"]||"").padStart(2,"0"); return ym.length===6?`${ym.slice(0,4)}-${ym.slice(4,6)}-${d}`:null; }
export async function transactions({ region, complexName, months=6, dealType="sale", limit=500 }={}) {
  const resolved=typeof region==="string"?await resolveRegion(region):region; const s=await startSession(); const toDate=isoDate(new Date()), fromDate=isoDate(monthsAgoDate(Math.max(1,Math.min(12,months)))); const f=form(resolved,{dealType,fromDate,toDate});
  const cr=await s.request(COUNT,{method:"POST",headers:{...headers(),"content-type":"application/x-www-form-urlencoded"},body:formBody(f),maxBytes:10000}); if(!cr.ok) throw new ProviderError("RTMS_HTTP",`count HTTP ${cr.status}`,{sourceApi:COUNT}); const cj=parseJson(cr.text,"count"); const announced=Number(cj.cnt); if(!Number.isFinite(announced)) throw new ProviderError("RTMS_CONTRACT","count missing"); if(announced>5000) throw new ProviderError("RESULT_TOO_LARGE",`RTMS query would return ${announced} rows; narrow the region/date range`);
  const rr=await s.request(CSV,{method:"POST",headers:{...headers(),"content-type":"application/x-www-form-urlencoded"},body:formBody(f),maxBytes:64_000_000,timeoutMs:60000}); if(!rr.ok) throw new ProviderError("RTMS_HTTP",`CSV HTTP ${rr.status}`,{sourceApi:CSV}); const text=new TextDecoder("euc-kr").decode(rr.bytes); let rows=dedupeSourceRows(parseCsv(text)); const target=complexName?normalizeName(complexName):null; if(target) rows=rows.filter(r=>{const n=normalizeName(r["단지명"]); return n===target||n.includes(target)||target.includes(n);});
  const data=rows.map(r=>({ source:"MOLIT_RTMS", source_row_no:r["NO"]||null, transaction_type:dealType==="sale"?"sale":"lease", lease_type:dealType!=="sale"?(r["전월세구분"]||null):null, region:r["시군구"], lot:r["번지"]||null, complex_name:r["단지명"]||null, exclusive_area_m2:numberValue(r["전용면적(㎡)"]), contract_date:dateFromRow(r), price_manwon:dealType==="sale"?numberValue(r["거래금액(만원)"]):null, deposit_manwon:dealType!=="sale"?numberValue(r["보증금(만원)"]):null, monthly_rent_manwon:dealType!=="sale"?numberValue(r["월세금(만원)"]):null, floor:numberValue(r["층"]), build_year:numberValue(r["건축년도"]), road_name:r["도로명"]||null, cancellation_date:(r["해제사유발생일"]&&r["해제사유발생일"]!=="-")?r["해제사유발생일"]:null, transaction_method:r["거래유형"]||null, contract_period:r["계약기간"]||null, contract_type:r["계약구분"]||null, renewal_right_used:r["갱신요구권 사용"]||null, previous_deposit_manwon:dealType!=="sale"?numberValue(r["종전계약 보증금(만원)"]):null, previous_monthly_rent_manwon:dealType!=="sale"?numberValue(r["종전계약 월세(만원)"]):null, housing_type:r["주택유형"]||null })).filter(x=>!x.cancellation_date).sort((a,b)=>String(b.contract_date).localeCompare(String(a.contract_date))).slice(0,limit);
  return { resolved_region:resolved, announced_count:announced, matched_count:rows.length, returned_count:data.length, transactions:data, source_api:CSV, from_date:fromDate,to_date:toDate, dedupe_policy:"response_source_row_no_only; distinct official rows are preserved even when their visible transaction fields match" };
}
