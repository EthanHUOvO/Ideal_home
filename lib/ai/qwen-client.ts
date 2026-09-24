import { getAiConfig } from './config'

export class QwenRequestError extends Error{
  status?:number
  stage:string
  model:string
  constructor(input:{message:string;status?:number;stage:string;model:string}){super(input.message);this.name='QwenRequestError';this.status=input.status;this.stage=input.stage;this.model=input.model}
}

async function withTimeout(url:string,init:RequestInit,timeoutMs:number,stage:string,model:string){
  const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),timeoutMs)
  try{
    const res=await fetch(url,{...init,signal:controller.signal})
    if(!res.ok){const text=await res.text();throw new QwenRequestError({message:`Qwen ${stage} failed: HTTP ${res.status} ${text.slice(0,1200)}`,status:res.status,stage,model})}
    return res
  }catch(error:any){
    if(error?.name==='AbortError')throw new QwenRequestError({message:`Qwen ${stage} timed out after ${timeoutMs}ms`,stage,model})
    throw error
  }finally{clearTimeout(timer)}
}

export function qwenBaseUrl(){return getAiConfig().compatBaseUrl}
export function qwenModel(){return getAiConfig().layoutModel}
export function qwenConfigured(){return Boolean(getAiConfig().apiKey)}

export async function qwenChatCompletion(body:Record<string,any>,options?:{model?:string;stage?:string}){
  const c=getAiConfig(),model=options?.model||c.layoutModel,stage=options?.stage||'text'
  if(!c.apiKey)throw new QwenRequestError({message:'QWEN_API_KEY is not configured',stage,model})
  const res=await withTimeout(`${c.compatBaseUrl}/chat/completions`,{
    method:'POST',headers:{'content-type':'application/json','authorization':`Bearer ${c.apiKey}`},
    body:JSON.stringify({model,enable_thinking:false,...body})
  },c.textTimeoutMs,stage,model)
  return await res.json()
}

export async function qwenChatJson(messages:any[],options?:{model?:string;stage?:string}){
  const data:any=await qwenChatCompletion({messages,response_format:{type:'json_object'},temperature:.15},options)
  const text=data.choices?.[0]?.message?.content||'{}'
  try{return JSON.parse(text)}catch{throw new QwenRequestError({message:`Qwen returned non-JSON content: ${String(text).slice(0,480)}`,stage:options?.stage||'json',model:options?.model||getAiConfig().layoutModel})}
}
