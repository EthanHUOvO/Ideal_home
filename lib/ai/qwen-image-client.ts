import { getAiConfig } from './config'
import { QwenRequestError } from './qwen-client'

export type QwenImageRequest={images?:string[];prompt:string;promptExtend?:boolean;negativePrompt?:string;size?:string;seed?:number;model?:string}

export async function qwenGenerateImage(input:QwenImageRequest){
  const c=getAiConfig(),model=input.model||c.imageModel
  if(c.mode!=='local'&&!c.apiKey)throw new QwenRequestError({message:'QWEN_API_KEY is not configured',stage:'image',model})
  const images=(input.images||[]).slice(0,3)
  const inputBytes=images.reduce((total,image)=>{
    if(!image.startsWith('data:'))return total
    const comma=image.indexOf(',')
    return total+(comma>=0?Math.ceil((image.length-comma-1)*3/4):0)
  },0)
  if(inputBytes>10*1024*1024)
    throw new QwenRequestError({message:'Image input exceeds Qwen Image 10MB limit',status:413,stage:'image',model})
  const content=[...images.map(image=>({image})),{text:input.prompt}]
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),c.imageTimeoutMs)
  try{
    if(c.mode==='local'){
      const res=await fetch(`${c.nativeBaseUrl}/v1/images/generations`,{
        method:'POST',signal:controller.signal,headers:{'content-type':'application/json'},
        body:JSON.stringify({model,prompt:input.prompt,images,size:input.size,negativePrompt:input.negativePrompt,seed:input.seed,steps:40,guidanceScale:1})
      })
      const responseText=await res.text();let data:any={};try{data=JSON.parse(responseText)}catch{}
      if(!res.ok)throw new QwenRequestError({message:`Local Qwen Image failed: HTTP ${res.status} ${responseText.slice(0,1200)}`,status:res.status,stage:'image',model})
      const url=data?.url||data?.data?.[0]?.url
      if(!url)throw new QwenRequestError({message:'Local Qwen Image response did not include an image URL',stage:'image',model})
      return{url,requestId:data?.requestId||'',usage:data?.usage||null,model,ephemeral:false}
    }
    const res=await fetch(`${c.nativeBaseUrl}/services/aigc/multimodal-generation/generation`,{
      method:'POST',signal:controller.signal,
      headers:{'content-type':'application/json','authorization':`Bearer ${c.apiKey}`},
      body:JSON.stringify({
        model,
        input:{messages:[{role:'user',content}]},
        parameters:{prompt_extend:input.promptExtend??true,n:1,...(input.size?{size:input.size}:{}),...(input.negativePrompt?{negative_prompt:input.negativePrompt}:{}),...(Number.isInteger(input.seed)?{seed:input.seed}:{}),watermark:false}
      })
    })
    const responseText=await res.text()
    let data:any={}
    try{data=JSON.parse(responseText)}catch{}
    console.info('[Qwen Image API Response]',{
      status:res.status,
      model,
      inputImageCount:images.length,
      inputBytes,
      responseKeys:Object.keys(data||{}),
      requestId:data?.request_id||res.headers.get('x-request-id')||'',
      hasOutput:Boolean(data?.output),
      outputWidth:data?.usage?.output_width,
      outputHeight:data?.usage?.output_height,
    })
    if(!res.ok)throw new QwenRequestError({message:`Qwen image failed: HTTP ${res.status} ${responseText.slice(0,1200)}`,status:res.status,stage:'image',model})
    const contentOutput=data?.output?.choices?.[0]?.message?.content
    const url=(Array.isArray(contentOutput)?contentOutput.find((x:any)=>x?.image||x?.image_url)?.image||contentOutput.find((x:any)=>x?.image_url)?.image_url?.url:undefined)
      || data?.output?.images?.[0]?.url
      || data?.output?.results?.[0]?.url
    if(!url)throw new QwenRequestError({message:`Qwen image response did not include a supported image URL`,stage:'image',model})
    return{url,requestId:data?.request_id||'',usage:data?.usage||null,model,ephemeral:true}
  }catch(error:any){
    if(error?.name==='AbortError')throw new QwenRequestError({message:`Qwen image timed out after ${c.imageTimeoutMs}ms`,status:504,stage:'image',model})
    throw error
  }finally{clearTimeout(timer)}
}
