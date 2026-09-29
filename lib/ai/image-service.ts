import { fallbackAllowed,getAiConfig,getAiMode,qwenConfigured } from './config'
import { qwenGenerateImage } from './qwen-image-client'
import { prepareFloorPlanForAI, prepareImageForInteriorEdit } from './server-image'
import { buildRoomTypePrompt, inferRoomType, roomTypeNegativePrompt, type RoomType } from '@/config/roomTypes'
import { BASE_EDIT_PROMPT, FINAL_RESULT_CONSTRAINT, LAYOUT_OPTIMIZATION_PROMPT } from '@/config/interiorStyles'

export type ImageMode='floorplan-edit'|'walkthrough-render'
export type FloorplanEditImageInput={
  mode:'floorplan-edit'
  /** The image selected in Step 1. This is the only image input for this mode. */
  originalFloorplan:string
  userPrompt:string
  residenceType?:'one'|'two'|'three'
}
export type WalkthroughRenderImageInput={
  mode:'walkthrough-render'
  /** A capture of the live Pascal/Three canvas. This is the only image input for this mode. */
  pascalScreenshot:string
  roomName?:string
  stylePrompt:string
  roomType?:RoomType
  imageModel?:string
  /** Keep interactive renovation renders within a predictable size/time budget. */
  size?:string
}
export type ImageGenerationInput=FloorplanEditImageInput|WalkthroughRenderImageInput

export const BASE_FLOOR_PLAN_EDIT_PROMPT = `请直接编辑输入的二维户型图。

修改要求：
{modificationRequest}

约束：
保持建筑外轮廓和承重结构不变。
除用户明确要求修改的区域外，其他区域保持原样。
保持原图二维俯视户型图的比例、线条、颜色和标注风格。
新增或调整房间时，应保证墙体、门洞和空间连通关系合理。

只执行用户要求的修改，不要重新设计整张户型。`

export function buildFloorPlanEditPrompt(modificationRequest:string){
  return modificationRequest.trim()
}

function fallbackImage(input:ImageGenerationInput){
  // Keep fallback output bound to this request. A fixed preset would make
  // option-02..08 appear to reuse option-01 when the online model is down.
  return input.mode==='floorplan-edit'?input.originalFloorplan:input.pascalScreenshot
}

function promptFor(input:ImageGenerationInput){
  if(input.mode==='floorplan-edit')return buildFloorPlanEditPrompt(input.userPrompt)
  const roomType = input.roomType || inferRoomType(input.roomName)
  return [BASE_EDIT_PROMPT, LAYOUT_OPTIMIZATION_PROMPT, `ROOM TYPE (${roomType}):\n${buildRoomTypePrompt(roomType, input.roomName)}`, `DESIGN STYLE (style language only; do not infer function or structure):\n${input.stylePrompt||'现代简约，原木+白色+浅灰'}`, FINAL_RESULT_CONSTRAINT].join("\n\n")
}

function validateImageInput(input: ImageGenerationInput) {
  const raw=input as unknown as Record<string,unknown>
  if (input.mode === 'floorplan-edit') {
    const forbidden=['sourceImage','originalImage','geometryGuide','pascalScreenshot','sceneToPng','walkthroughScreenshot','rendererCanvas','sceneSnapshot','pascalScene','layoutPlan','operations','sourceIsFinal']
    if(forbidden.some(key=>Object.prototype.hasOwnProperty.call(raw,key)))
      throw new Error('Floorplan edit must use the original selected floorplan only.')
    if (!input.originalFloorplan || !String(input.userPrompt||'').trim())
      throw new Error('floorplan-edit requires originalFloorplan')
  } else if (input.mode === 'walkthrough-render') {
    if(['originalFloorplan','originalImage','geometryGuide','sceneSnapshot','pascalScene','sourceIsFinal'].some(key=>Object.prototype.hasOwnProperty.call(raw,key)))
      throw new Error('Walkthrough render must use the Pascal screenshot only.')
    if (!input.pascalScreenshot || !String(input.stylePrompt||'').trim())
      throw new Error('walkthrough-render requires pascalScreenshot and stylePrompt')
  }
}

export async function generateDreamHouseImage(input:ImageGenerationInput){
  validateImageInput(input)
  const c=getAiConfig(),mode=getAiMode()
  if(mode==='mock')return{provider:'mock' as const,model:'local-preset',url:fallbackImage(input),ephemeral:false,fallback:false,prompt:promptFor(input)}
  if(!qwenConfigured()){
    if(fallbackAllowed())return{provider:'mock' as const,model:'local-preset',url:fallbackImage(input),ephemeral:false,fallback:true,fallbackReason:'QWEN_API_KEY is not configured',prompt:promptFor(input)}
    throw new Error('QWEN_API_KEY is not configured')
  }
  try{
    const source = input.mode === 'floorplan-edit'
      ? input.originalFloorplan
      : input.pascalScreenshot
    const sources=[source].filter(Boolean) as string[]
    if(!sources.length)throw new Error('originalImage or sourceImage is required')
    const prepared = input.mode === 'walkthrough-render'
      ? await prepareImageForInteriorEdit(sources[0])
      : await prepareFloorPlanForAI(sources[0])
    const images=[prepared.dataUrl]
    const outputSize = input.mode === 'walkthrough-render'
      ? (input.size || process.env.QWEN_IMAGE_SIZE || prepared.size)
      : prepared.size
    const finalPrompt=promptFor(input)
    if(input.mode==='floorplan-edit'){
      console.info('[FLOOR PLAN I2I REQUEST]', {
        model:c.imageModel,
        imageCount:1,
        textCount:1,
        sourceImageWidth:prepared.width,
        sourceImageHeight:prepared.height,
        sourceAspectRatio:prepared.width&&prepared.height?Number((prepared.width/prepared.height).toFixed(4)):undefined,
        sourceImageBytes:'bytes' in prepared?prepared.bytes:undefined,
        promptLength:finalPrompt.length,
        prompt_extend:false,
        prompt_extend_mode:'not sent',
        enable_thinking:'not sent',
        outputSize,
        negativePromptLength:0,
        n:1,
      })
    }else{
      console.info('[Qwen Interior Edit]', {
        mode:'image-to-image',
        roomType:input.roomType || inferRoomType(input.roomName),
        roomName:input.roomName,
        hasImage:Boolean(prepared.dataUrl),
        sourceImageType:prepared.dataUrl.slice(0,prepared.dataUrl.indexOf(',')),
        sourceWidth:prepared.width,
        sourceHeight:prepared.height,
        outputSize,
        model:input.imageModel || c.imageModel,
      })
    }
    const result=await qwenGenerateImage({
      images,
      prompt:finalPrompt,
      // STEP 4 already sends a complete style/geometry prompt. Prompt
      // rewriting adds substantial latency for image-to-image requests and
      // can make the interactive route hit its timeout, so keep it disabled.
      promptExtend:false,
      negativePrompt:input.mode==='walkthrough-render'
        ? `different room, different viewpoint, changed camera, changed perspective, moved walls, relocated doors, relocated windows, new architectural layout, extra rooms, missing rooms, ${roomTypeNegativePrompt(input.roomType || inferRoomType(input.roomName))}`
        : undefined,
      model:input.mode==='walkthrough-render'?input.imageModel:undefined,
      // The provider's automatic size selection can choose a large output and
      // exceed the interactive request timeout. Keep the size configurable,
      // with a bounded default for walkthrough renders.
      size:outputSize,
    })
    return{provider:'qwen' as const,model:result.model,url:result.url,ephemeral:result.ephemeral,fallback:false,requestId:result.requestId,inputImageCount:images.length,prompt:promptFor(input)}
  }catch(error:any){
    console.error('[DreamHouse][image][qwen]',{model:c.imageModel,mode:input.mode,status:error?.status,message:error?.message})
    if(fallbackAllowed())return{provider:'mock' as const,model:'local-preset',url:fallbackImage(input),ephemeral:false,fallback:true,fallbackReason:error?.message||'Qwen image failed',prompt:promptFor(input)}
    throw error
  }
}

export async function persistGeneratedImage(url:string){
  // Hook point for OSS. Qwen Image result URLs are temporary; the official API currently keeps them for about 24h.
  // Serverless deployments should upload the remote image to OSS/S3 rather than trying to write into /public at runtime.
  return{url,persisted:false,reason:process.env.ALIYUN_OSS_BUCKET?'OSS variables are present but uploader is intentionally left as an adapter hook':'OSS is not configured'}
}
