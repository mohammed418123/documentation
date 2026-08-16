import { createClient } from 'npm:@supabase/supabase-js@2';
const admin=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
const headers={'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-cache','Access-Control-Allow-Origin':'*'};
Deno.serve(async(req:Request)=>{
  try{
    const u=new URL(req.url);
    if(u.searchParams.get('mode')==='snapshot'){
      const r=await fetch('https://odoo-payment-portal.vercel.app/',{headers:{'User-Agent':'CollectionPortalSnapshot/1.0'}});
      if(!r.ok) return new Response('snapshot fetch failed '+r.status,{status:500});
      let html=await r.text();
      if(!html.includes('بوابة التحصيل')) return new Response('unexpected source',{status:500});
      html=html.replace(/<script async data-explicit-opt-in=[\s\S]*?<\/script>/g,'');
      const {error}=await admin.from('collection_portal_assets').upsert({asset_name:'v5_base',asset_content:html,updated_at:new Date().toISOString()});
      if(error) throw error;
      return new Response('SNAPSHOT_OK '+html.length,{headers:{'Content-Type':'text/plain; charset=utf-8'}});
    }
    const {data,error}=await admin.from('collection_portal_assets').select('asset_content').eq('asset_name','v5_base').single();
    if(error||!data?.asset_content) return new Response('No snapshot',{status:503});
    let html=String(data.asset_content);
    html=html.replace('<meta name="application-name" content="بوابة التحصيل v5">','<meta name="application-name" content="بوابة التحصيل v6 المركزي">');
    const inject='<script src="/central-v6.js"></script>';
    html=html.includes('</body>')?html.replace('</body>',inject+'</body>'):html+inject;
    return new Response(html,{headers});
  }catch(e){return new Response('site backend error: '+(e?.message||String(e)),{status:500,headers:{'Content-Type':'text/plain; charset=utf-8'}})}
});