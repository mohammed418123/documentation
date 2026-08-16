const PROD_SITE = "https://red-planet-collection.vercel.app";
const PROD_API = "https://ekezixsgyihoivhaudbm.supabase.co/functions/v1/collection-portal-api-v2";
const SALARY_STAGING_API = "https://ekezixsgyihoivhaudbm.supabase.co/functions/v1/collection-salary-advance-staging";
const STAGING_SITE_API = "https://ekezixsgyihoivhaudbm.supabase.co/functions/v1/collection-portal-staging-site?api=1";

const BLOCKED_ACTIONS = new Set([
  "partner_create","pending_create","pending_settle","draft_save","receipt_delete","batch_approve",
  "deposit_save","deposit_post","deposit_reject","expense_save","expense_submit","expense_approve",
  "expense_reject","expense_request_correction","expense_delete","closure_save","user_save",
  "settings_save","odoo_key_save"
]);

function headers(contentType = "application/json; charset=utf-8") {
  return {
    "content-type": contentType,
    "cache-control": "no-store",
    "x-robots-tag": "noindex, nofollow, noarchive",
    "x-content-type-options": "nosniff",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
    "access-control-allow-methods": "GET, POST, OPTIONS",
  };
}
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: headers() });
}

async function proxyApi(req: Request) {
  const raw = await req.text();
  let body: any = {};
  try { body = raw ? JSON.parse(raw) : {}; }
  catch { return json({ok:false,error:{code:"BAD_JSON",message:"بيانات الطلب غير صحيحة"}},400); }

  const action = String(body.action || "");
  if (action.startsWith("salary_advance_")) {
    const r = await fetch(SALARY_STAGING_API, {
      method: "POST",
      headers: {"content-type":"application/json"},
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(45000),
    });
    return new Response(await r.arrayBuffer(), {
      status: r.status,
      headers: headers(r.headers.get("content-type") || "application/json; charset=utf-8"),
    });
  }

  if (BLOCKED_ACTIONS.has(action)) {
    return json({ok:false,error:{code:"STAGING_WRITE_BLOCKED",category:"staging",message:"هذه نسخة تجريبية. تم حظر هذا الإجراء حتى لا يغيّر بيانات الإنتاج أو ينشئ أثرًا ماليًا في Odoo.",request_id:crypto.randomUUID()}},409);
  }

  const r = await fetch(PROD_API, {
    method: "POST",
    headers: {"content-type":"application/json"},
    body: raw,
    signal: AbortSignal.timeout(45000),
  });
  return new Response(await r.arrayBuffer(), {
    status: r.status,
    headers: headers(r.headers.get("content-type") || "application/json; charset=utf-8"),
  });
}

const STAGING_PATCH = String.raw`
<style>
html::before{content:"نسخة تجريبية STAGING — لا تنفذ أي قيود مالية على Odoo";display:block;position:sticky;top:0;z-index:2147483647;background:#fff3cd;color:#664d03;border-bottom:1px solid #ffecb5;padding:9px 14px;text-align:center;font:700 13px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif}
.staging-clickable-row{cursor:pointer}.staging-clickable-row:hover{background:rgba(13,110,253,.055)!important}.staging-clickable-row:focus{outline:2px solid rgba(13,110,253,.45);outline-offset:-2px}.staging-detail-overlay{position:fixed;inset:0;background:rgba(0,0,0,.34);z-index:2147483646;display:flex;align-items:center;justify-content:center;padding:18px}.staging-detail-card{background:#fff;width:min(720px,96vw);max-height:84vh;overflow:auto;border-radius:16px;box-shadow:0 24px 80px rgba(0,0,0,.25);padding:20px;direction:rtl}.staging-detail-grid{display:grid;grid-template-columns:minmax(110px,.7fr) minmax(160px,1.3fr);gap:0;border:1px solid #e8e8e8;border-radius:10px;overflow:hidden}.staging-detail-grid>div{padding:10px 12px;border-bottom:1px solid #eee}.staging-detail-grid>div:nth-child(odd){font-weight:700;background:#fafafa}.staging-detail-close{margin-top:16px;width:100%}
</style>
<script>
(function(){
  const API_PROXY = '${STAGING_SITE_API}';
  const originalFetch = window.fetch.bind(window);
  window.__COLLECTION_STAGING__ = true;
  window.fetch = async function(input, init){
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    if (url.indexOf('/functions/v1/collection-portal-api-v2') !== -1) {
      return originalFetch(API_PROXY, Object.assign({}, init || {}, {method:(init&&init.method)||'POST'}));
    }
    return originalFetch(input, init);
  };

  function cellLabel(row,index){const t=row.closest('table');const h=t?Array.from(t.querySelectorAll('thead th')):[];return (h[index]&&h[index].textContent||('الحقل '+(index+1))).trim().replace(/\s+/g,' ')}
  function showDetails(row){
    document.querySelector('.staging-detail-overlay')?.remove();
    const cells=Array.from(row.children).filter(el=>el.tagName==='TD');
    const o=document.createElement('div');o.className='staging-detail-overlay';
    const c=document.createElement('div');c.className='staging-detail-card';
    const h=document.createElement('h3');h.textContent='تفاصيل العملية — نسخة تجريبية';c.appendChild(h);
    const g=document.createElement('div');g.className='staging-detail-grid';
    cells.forEach((cell,i)=>{const l=document.createElement('div');l.textContent=cellLabel(row,i);const v=document.createElement('div');v.textContent=(cell.innerText||'').trim().replace(/\s+/g,' ')||'—';g.appendChild(l);g.appendChild(v)});
    c.appendChild(g);const b=document.createElement('button');b.type='button';b.className='btn secondary staging-detail-close';b.textContent='إغلاق';b.onclick=()=>o.remove();c.appendChild(b);o.appendChild(c);o.addEventListener('click',e=>{if(e.target===o)o.remove()});document.body.appendChild(o)
  }
  function preferred(row){const bs=Array.from(row.querySelectorAll('button')).filter(b=>!b.disabled);const by=r=>bs.find(b=>r.test((b.textContent||'').trim()));return by(/تعديل/)||by(/عرض|تفاصيل/)||by(/توريد\s*المعل[ّ]?ق/)}
  function activate(row){if(row.dataset.stagingRow==='1'||row.querySelector('input,select,textarea')||!row.querySelector('td'))return;row.dataset.stagingRow='1';row.classList.add('staging-clickable-row');row.tabIndex=0;const open=()=>{const b=preferred(row);if(b)b.click();else showDetails(row)};row.addEventListener('click',e=>{if(e.target.closest('button,a,input,select,textarea,label,[role="button"]'))return;open()});row.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();open()}})}
  function enhance(){document.querySelectorAll('tbody tr').forEach(activate)}
  function boot(){document.title='[STAGING] '+document.title;enhance();new MutationObserver(enhance).observe(document.body,{childList:true,subtree:true})}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot);else boot();
})();
</script>`;

let cachedHtml = "";
let cachedAt = 0;
async function renderSelfContained() {
  if (cachedHtml && Date.now() - cachedAt < 120000) return cachedHtml;
  const home = await fetch(PROD_SITE + "/", {signal: AbortSignal.timeout(30000)});
  if (!home.ok) throw new Error("PROD_HTML_" + home.status);
  let html = await home.text();
  const jsMatch = html.match(/<script[^>]+src="([^"]+\.js)"[^>]*><\/script>/i);
  const cssMatch = html.match(/<link[^>]+href="([^"]+\.css)"[^>]*>/i);
  if (!jsMatch || !cssMatch) throw new Error("ASSET_TAGS_NOT_FOUND");

  const [jsRes, cssRes] = await Promise.all([
    fetch(new URL(jsMatch[1], PROD_SITE), {signal: AbortSignal.timeout(30000)}),
    fetch(new URL(cssMatch[1], PROD_SITE), {signal: AbortSignal.timeout(30000)}),
  ]);
  if (!jsRes.ok || !cssRes.ok) throw new Error("ASSET_FETCH_FAILED");
  let js = await jsRes.text();
  const css = await cssRes.text();
  js = js.replace(/<\/script/gi, '<\\/script');
  html = html.replace(cssMatch[0], `<style>${css}</style>`);
  html = html.replace(jsMatch[0], `${STAGING_PATCH}<script type="module">${js}</script>`);
  cachedHtml = html;
  cachedAt = Date.now();
  return html;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", {headers:headers()});
  const url = new URL(req.url);
  if (req.method === "POST" && url.searchParams.get("api") === "1") return await proxyApi(req);
  if (req.method !== "GET") return json({ok:false,error:{message:"GET only"}},405);
  try {
    const html = await renderSelfContained();
    return new Response(html,{status:200,headers:headers("text/html; charset=utf-8")});
  } catch (e) {
    return new Response("تعذر تجهيز النسخة التجريبية: " + String(e instanceof Error ? e.message : e), {status:502,headers:headers("text/plain; charset=utf-8")});
  }
});
