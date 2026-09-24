import type { AiDesignProposal, BomAiEnrichment, VisualConcept, VideoConcept } from '../types'
import type { AiProvider, BomEnrichmentRequest, LayoutRequest, PlanRequest, RenderRequest, VideoRequest } from './provider'
import { qwenChatJson } from './qwen-client'
import { getAiConfig } from './config'
import { qwenGenerateImage } from './qwen-image-client'
import { resolveImageInput } from './server-image'
import { runQwenLayoutAgent } from './qwen-layout-agent'

function must(name:string){const v=process.env[name];if(!v)throw new Error(`${name} is not configured`);return v}


export function createQwenProvider():AiProvider{
  return{
    id:'qwen',
    async generatePlans(input:PlanRequest):Promise<AiDesignProposal[]>{
      const payload=await qwenChatJson([
        {role:'system',content:'你是DreamHouse住宅快速方案助手。只输出JSON，给出3个候选方案。原则：外墙和承重墙保持不变。字段必须包含 proposals:[{title,summary,scenario,strategy,goals,roomChanges,wallChanges,furnitureAdvice,score}]。scenario只能为 single,single_female,couple,child,nanny,replan；strategy只能为 balanced,storage,growth。这里是“快速方案”，自由空间重构由另一个Layout Agent完成。'},
        {role:'user',content:JSON.stringify(input)}
      ])
      const arr=Array.isArray(payload.proposals)?payload.proposals:[]
      return arr.map((p:any,i:number)=>({...p,id:p.id||`QWEN-${Date.now()}-${i}`,provider:'qwen',createdAt:new Date().toISOString()}))
    },
    async generateLayout(input:LayoutRequest){return runQwenLayoutAgent(input)},
    async generateVisual(input:RenderRequest):Promise<VisualConcept>{
      const image=input.sourceImage?await resolveImageInput(input.sourceImage):undefined
      const result=await qwenGenerateImage({images:image?[image]:undefined,prompt:`DreamHouse住宅空间效果图。房间：${input.room}。风格：${input.style}。保持输入户型的空间边界、门窗位置和房间比例，不增加不存在的空间。现代、真实、可落地，无人物、无水印。`,promptExtend:true})
      return{id:`VIS-QWEN-${Date.now()}`,style:input.style,roomId:input.roomId,room:input.room,prompt:`${input.room} / ${input.style}`,imageDataUrl:result.url,provider:'qwen-image',status:'ready',createdAt:new Date().toISOString()}
    },
    async generateVideo(input:VideoRequest):Promise<VideoConcept>{
      must('WAN_VIDEO_ENDPOINT')
      throw new Error('Wan video adapter is reserved. Configure the concrete purchased video API contract in this method.')
    },
    async enrichBom(input:BomEnrichmentRequest):Promise<BomAiEnrichment>{
      const compactItems=input.draftItems.map(item=>({id:item.id,level:item.level,category:item.category,roomId:item.roomId,room:item.room,label:item.label,specification:item.specification,quantity:item.quantity,unit:item.unit,material:item.material,source:item.source,sourceNodeId:item.sourceNodeId}))
      const context={profile:input.profile,drawing:input.drawing?{fileName:input.drawing.fileName,fileType:input.drawing.fileType,templateId:input.drawing.templateId,detected:input.drawing.detected}:undefined,design:{version:input.design.version,label:input.design.label,scenario:input.design.scenario},geometry:input.geometry,materialCatalog:input.materialCatalog,manufacturingRules:input.manufacturingRules,draftItems:compactItems}
      const userContent:any[]=input.drawing?.previewDataUrl&&input.drawing.fileType.startsWith('image/')?[{type:'image_url',image_url:{url:input.drawing.previewDataUrl}},{type:'text',text:JSON.stringify(context)}]:[{type:'text',text:JSON.stringify(context)}]
      const payload=await qwenChatJson([
        {role:'system',content:'你是DreamHouse BOM材料与制造工艺助手。DreamHouse几何引擎已经计算了所有数量、尺寸、面积和sourceNodeId；你绝对不能修改这些工程量。只为现有itemId补充 material、finish、process、installationMethod、performance、notes。只输出JSON：{summary:string,items:[{itemId,material?,finish?,process?,installationMethod?,performance?:string[],notes?}]}。不得增加不存在的itemId。优先结合用户画像、二维户型图、材料目录和制造规则。'},
        {role:'user',content:userContent}
      ],{model:getAiConfig().bomModel,stage:'bom'})
      return{summary:String(payload.summary||''),items:Array.isArray(payload.items)?payload.items:[]}
    }
  }
}
