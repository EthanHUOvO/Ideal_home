import { NextResponse } from 'next/server'
import { getAiConfig,qwenConfigured } from '@/lib/ai/config'
import { qwenChatCompletion } from '@/lib/ai/qwen-client'

export const runtime='nodejs'
export async function GET(){
  const c=getAiConfig()
  const imageModel=process.env.QWEN_INTERIOR_IMAGE_MODEL||c.imageModel
  let textAuthenticated=false,imageAuthenticated=false,authStatus:number|undefined,authMessage:string|undefined,imageAuthStatus:number|undefined,imageAuthMessage:string|undefined
  if(qwenConfigured()) {
    try { const r:any=await qwenChatCompletion({messages:[{role:'user',content:'Reply OK'}],max_tokens:2},{model:c.layoutModel,stage:'auth-probe'}); textAuthenticated=Boolean(r?.choices); authStatus=200 } catch(e:any) { authStatus=e?.status||401; authMessage=String(e?.message||'authentication failed').slice(0,200) }
    try { const r=await fetch(`${c.nativeBaseUrl}/services/aigc/multimodal-generation/generation`,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${c.apiKey}`},body:JSON.stringify({model:imageModel,input:{messages:[]},parameters:{watermark:false}})});imageAuthStatus=r.status;imageAuthenticated=r.status!==401&&r.status!==403;if(!r.ok)imageAuthMessage=(await r.text()).slice(0,200) } catch(e:any) { imageAuthMessage=String(e?.message||'image authentication probe failed').slice(0,200) }
  }
  return NextResponse.json({
    mode:c.mode,
    qwenConfigured:qwenConfigured(),
    qwenAuthenticated:textAuthenticated,textAuthenticated,imageAuthenticated,authStatus,authMessage,imageAuthStatus,imageAuthMessage,
    models:{layout:c.layoutModel,image:imageModel,bom:c.bomModel},
    endpoints:{textConfigured:Boolean(c.compatBaseUrl),imageConfigured:Boolean(c.nativeBaseUrl)},
    persistence:{ossConfigured:Boolean(process.env.ALIYUN_OSS_BUCKET),imageUrlsMayExpire:true},
  })
}
