export type AiMode='mock'|'qwen'|'hybrid'

function num(name:string,fallback:number){const v=Number(process.env[name]);return Number.isFinite(v)&&v>0?v:fallback}

export function getAiMode():AiMode{
  const raw=String(process.env.AI_MODE||process.env.AI_PROVIDER||'mock').toLowerCase()
  return raw==='mock'||raw==='qwen'||raw==='hybrid'?raw:'hybrid'
}

export function getAiConfig(){
  return{
    mode:getAiMode(),
    apiKey:process.env.QWEN_API_KEY||process.env.DASHSCOPE_API_KEY||'',
    compatBaseUrl:(process.env.QWEN_COMPAT_BASE_URL||process.env.QWEN_BASE_URL||'https://dashscope.aliyuncs.com/compatible-mode/v1').replace(/\/$/,''),
    nativeBaseUrl:(process.env.QWEN_NATIVE_BASE_URL||'https://dashscope.aliyuncs.com/api/v1').replace(/\/$/,''),
    layoutModel:process.env.QWEN_LAYOUT_MODEL||process.env.QWEN_TEXT_MODEL||'qwen3.8-flash',
    bomModel:process.env.QWEN_BOM_MODEL||process.env.QWEN_TEXT_MODEL||'qwen3.8-flash',
    imageModel:process.env.QWEN_IMAGE_MODEL||'qwen-image-3.0-pro',
    textTimeoutMs:num('QWEN_TEXT_TIMEOUT_MS',60000),
    imageTimeoutMs:num('QWEN_IMAGE_TIMEOUT_MS',120000),
  }
}

export function qwenConfigured(){return Boolean(getAiConfig().apiKey)}
export function shouldTryQwen(){const c=getAiConfig();return c.mode!=='mock'&&Boolean(c.apiKey)}
export function fallbackAllowed(){return getAiMode()==='hybrid'}
