export interface LyricWord {
  t: number
  end: number
  text: string
  from: number
  to: number
}
export interface LyricLine {
  /** Seconds, after LRC offset. */
  t: number
  text: string
  sub: string
  words?: LyricWord[]
  subWords?: LyricWord[]
}
const TIME = /(?:\[(\d+):(\d+(?:\.\d+)?)\]|<(\d+):(\d+(?:\.\d+)?)>)/g
const seconds = (tag: RegExpMatchArray): number => Number(tag[1] ?? tag[3])*60+Number(tag[2] ?? tag[4])
/** Ordinary repeated leading stamps, enhanced LRC <stamps>, and LDDC [word] stamps. */
export function parseLRC(src: string): LyricLine[] {
  const offset = Number(/\[offset:\s*([+-]?\d+)\]/i.exec(src)?.[1] ?? 0)/1000
  const raw: LyricLine[] = []
  for (const source of src.replace(/^\uFEFF/,'').split(/\r?\n/)) {
    const tags = [...source.matchAll(TIME)]
    if (!tags.length) continue
    let leading = 1
    while (leading < tags.length && tags[leading]![0].startsWith('[') && !source.slice(tags[leading-1]!.index!+tags[leading-1]![0].length,tags[leading]!.index).trim()) leading++
    const anchor = tags[leading-1]!
    const inline = tags.slice(leading)
    const timed = inline.length > 0 || tags.some(t=>t[0].startsWith('<'))
    let text = '', words: LyricWord[] = []
    if (timed) {
      const stream = [anchor,...inline]
      for (let i=0;i<stream.length;i++) {
        const stamp=stream[i]!, next=stream[i+1]
        const fragment = source.slice(stamp.index!+stamp[0].length,next?.index).replace(/\[(?:ar|ti|al|by|tool|offset):[^\]]*\]/gi,'')
        if (!fragment) continue
        const start = Math.max(0,seconds(stamp)-offset)
        words.push({t:start,end:next?Math.max(start,seconds(next)-offset):NaN,text:fragment,from:text.length,to:text.length+fragment.length})
        text += fragment
      }
    } else text=source.slice(anchor.index!+anchor[0].length).trim()
    for (const tag of tags.slice(0,leading)) {
      const t=Math.max(0,seconds(tag)-offset), delta=t-Math.max(0,seconds(anchor)-offset)
      raw.push({t,text,sub:'',...(words.length?{words:words.map(w=>({...w,t:Math.max(0,w.t+delta),end:w.end+delta}))}:{})})
    }
  }
  raw.sort((a,b)=>a.t-b.t)
  const out:LyricLine[]=[]
  for (const item of raw) {
    const last=out.at(-1)
    if (last && Math.abs(last.t-item.t)<.005) {
      if (!last.text && item.text) Object.assign(last,item)
      else if (last.text && item.text && last.text!==item.text && !last.sub) { last.sub=item.text; last.subWords=item.words }
    } else out.push(item)
  }
  for (let i=0;i<out.length;i++) {
    const line=out[i]!, next=out[i+1]?.t
    for (const word of [...(line.words??[]),...(line.subWords??[])])
      if (!Number.isFinite(word.end)) word.end=Math.max(word.t+.05,next??word.t+.5)
  }
  if (!out.length) {
    const text=src.replace(/\[[a-z]+:[^\]]*\]/gi,'').trim()
    if (text) out.push({t:0,text,sub:''})
  }
  return out
}
export const wordProgress = (word:LyricWord,time:number):number => Math.max(0,Math.min(1,(time-word.t)/Math.max(.001,word.end-word.t)))
/** Fraction through the shaped line; caller supplies measured prefix widths. */
export function sungWidth(words:LyricWord[]|undefined,time:number,measure:(text:string)=>number,text:string):number {
  if (!words?.length) return measure(text)
  let width=0
  for (const word of words) {
    const start=measure(text.slice(0,word.from)), end=measure(text.slice(0,word.to))
    width=Math.max(width,start+(end-start)*wordProgress(word,time))
    if (time<word.end) break
  }
  return width
}
