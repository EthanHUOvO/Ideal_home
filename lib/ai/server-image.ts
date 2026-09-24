import fs from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'

function mime(file:string){const ext=path.extname(file).toLowerCase();if(ext==='.jpg'||ext==='.jpeg')return'image/jpeg';if(ext==='.webp')return'image/webp';if(ext==='.gif')return'image/gif';return'image/png'}

export async function resolveImageInput(value:string):Promise<string>{
  if(!value)throw new Error('image input is empty')
  if(/^https?:\/\//i.test(value)||value.startsWith('data:image/'))return value
  if(!value.startsWith('/'))throw new Error('Only public paths, HTTP(S) URLs, or image data URLs are supported')
  const full=path.join(process.cwd(),'public',value.replace(/^\//,''))
  const data=await fs.readFile(full)
  if(data.byteLength>10*1024*1024)throw new Error('Image input exceeds Qwen Image 10MB limit')
  return `data:${mime(full)};base64,${data.toString('base64')}`
}

export type PreparedInteriorImage = {
  dataUrl: string
  width?: number
  height?: number
  size?: string
}

export type PreparedFloorPlanImage = PreparedInteriorImage & { bytes?: number }

export async function prepareFloorPlanForAI(value:string):Promise<PreparedFloorPlanImage>{
  if(!value)throw new Error('SOURCE_FLOOR_PLAN_REQUIRED')
  const resolved=await resolveImageInput(value)
  if(!resolved.startsWith('data:image/'))throw new Error('SOURCE_FLOOR_PLAN_INVALID')
  const comma=resolved.indexOf(',')
  if(comma<0)throw new Error('SOURCE_FLOOR_PLAN_INVALID')
  const source=Buffer.from(resolved.slice(comma+1),'base64')
  if(!source.length)throw new Error('SOURCE_FLOOR_PLAN_INVALID')
  if(source.byteLength>10*1024*1024)throw new Error('SOURCE_FLOOR_PLAN_TOO_LARGE')
  const metadata=await sharp(source).metadata()
  const sourceWidth=metadata.width,sourceHeight=metadata.height
  if(!sourceWidth||!sourceHeight)throw new Error('SOURCE_FLOOR_PLAN_INVALID')

  const maxDimension=Number(process.env.QWEN_FLOORPLAN_MAX_DIMENSION||1536)
  const maxArea=2048*2048
  let scale=Math.min(1,maxDimension/Math.max(sourceWidth,sourceHeight))
  if(sourceWidth*sourceHeight*scale*scale>maxArea)
    scale=Math.sqrt(maxArea/(sourceWidth*sourceHeight))
  const width=Math.max(1,Math.floor(sourceWidth*scale))
  const height=Math.max(1,Math.floor(sourceHeight*scale))
  const needsResize=width!==sourceWidth||height!==sourceHeight
  const output=needsResize
    ? await sharp(source).resize(width,height,{fit:'inside',withoutEnlargement:true}).png().toBuffer()
    : source
  const mimeType=needsResize?'image/png':resolved.slice(5,resolved.indexOf(';'))
  return{
    dataUrl:`data:${mimeType};base64,${output.toString('base64')}`,
    width,
    height,
    size:`${width}*${height}`,
    bytes:output.byteLength,
  }
}

/**
 * Normalize a captured canvas image for Qwen I2I while preserving its aspect
 * ratio. The returned size is also used for the generated image so the model
 * does not crop a wide or portrait camera view into a square.
 */
export async function prepareImageForInteriorEdit(value:string):Promise<PreparedInteriorImage>{
  const resolved=await resolveImageInput(value)
  if(!resolved.startsWith('data:image/'))return{dataUrl:resolved}
  const comma=resolved.indexOf(',')
  if(comma<0)throw new Error('Invalid image data URL')
  const header=resolved.slice(0,comma)
  const encoded=resolved.slice(comma+1)
  const source=Buffer.from(encoded,'base64')
  const metadata=await sharp(source).metadata()
  const sourceWidth=metadata.width,sourceHeight=metadata.height
  if(!sourceWidth||!sourceHeight)throw new Error('Unable to read source image dimensions')

  const maxDimension=Number(process.env.QWEN_INTERIOR_MAX_DIMENSION||1536)
  const minArea=512*512
  const maxArea=2048*2048
  let scale=Math.min(1,maxDimension/Math.max(sourceWidth,sourceHeight))
  if(sourceWidth*sourceHeight*scale*scale<minArea)
    scale=Math.sqrt(minArea/(sourceWidth*sourceHeight))
  const width=Math.max(1,Math.round(sourceWidth*scale))
  const height=Math.max(1,Math.round(sourceHeight*scale))
  const pixelScale=Math.sqrt(maxArea/(width*height))
  const finalWidth=pixelScale<1?Math.max(1,Math.floor(width*pixelScale)):width
  const finalHeight=pixelScale<1?Math.max(1,Math.floor(height*pixelScale)):height
  const needsResize=finalWidth!==sourceWidth||finalHeight!==sourceHeight||!/^data:image\/png/i.test(header)
  const output=needsResize
    ? await sharp(source).resize(finalWidth,finalHeight,{fit:'fill'}).png().toBuffer()
    : source
  return{
    dataUrl:`data:image/png;base64,${output.toString('base64')}`,
    width:finalWidth,
    height:finalHeight,
    size:`${finalWidth}*${finalHeight}`,
  }
}
