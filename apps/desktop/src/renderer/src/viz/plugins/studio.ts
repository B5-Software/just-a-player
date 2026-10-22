import type { VisualPlugin } from '@shared/visual-plugin'

const sculpture = (field: string, finish: string): string => `
float field(vec3 p){${field}}
vec3 visualize(vec2 uv){
  vec2 p=screenPoint(uv);
  vec3 ro=vec3(.15*uPointer.x,.10*uPointer.y,5.2),rd=normalize(vec3(p*5.2,-5.2));
  vec3 bg=background(uv);
  float b=dot(ro,rd),disc=b*b-dot(ro,ro)+2.5;
  if(disc<0.)return bg;
  float t=max(0.,-b-sqrt(disc)),d=0.;
  for(int i=0;i<64;i++){d=field(ro+rd*t);if(abs(d)<.0015||t>8.)break;t+=max(abs(d)*.65,.001);}
  if(t>8.)return bg;
  vec3 at=ro+rd*t;vec2 e=vec2(.002,0.);
  vec3 n=normalize(vec3(field(at+e.xyy)-field(at-e.xyy),field(at+e.yxy)-field(at-e.yxy),field(at+e.yyx)-field(at-e.yyx)));
  ${finish}
  float vignette=1.-smoothstep(.5,1.2,length(uv-.5))*.14;
  return mix(bg,col,1.-smoothstep(.001,.006,abs(d)))*vignette;
}`
const silk = sculpture(
  `
 p.xy=rotate(-.32)*p.xy;p.yz=rotate(-.55)*p.yz;
 float angle=atan(p.y*1.35,p.x);
 float ring=length(vec2(p.x,p.y*1.35));
 float fold=.32*sin(angle*2.+uTime*.08)+.10*cos(angle*3.)+uAudio.x*.06;
 vec2 edge=vec2(abs(ring-1.)-.26,abs(p.z-fold)-.026);
 return length(max(edge,0.))+min(max(edge.x,edge.y),0.)-.025;
`,
  `
 float weave=.5+.5*sin(at.x*250.+at.y*18.);
 vec3 pigment=mix(vec3(.08,.10,.15),uAccent*.50+vec3(.035),.65+.10*sin(at.y*2.));
 vec3 col=studioLight(n,-rd,pigment,.35)*(1.+weave*.012);
`
)
const glass = sculpture(
  `
 p.xy=rotate(.25)*p.xy;p.yz=rotate(-.40)*p.yz;
 float fold=.38*sin(p.x*2.0+uTime*.10)+.22*cos(p.y*3.4-uTime*.07);
 float sheet=abs(p.z-fold)-.027;
 vec2 box=abs(p.xy)-vec2(1.20,.62);
 float border=length(max(box,0.))+min(max(box.x,box.y),0.)-.20;
 return max(sheet,border);
`,
  `
 float fresnel=pow(1.-abs(dot(n,-rd)),2.);
 vec2 bend=clamp(uv+n.xy*.10,.01,.99);
 vec3 through=background(bend)*1.5;
 vec3 light=studioLight(n,-rd,mix(vec3(.20),uSecond,.35),.92);
 vec3 col=mix(through,light,.32+fresnel*.60)+uAccent*.08+vec3(.14)*pow(clamp(n.y+.5,0.,1.),2.);
`
)
const landscape = (water: boolean): string => `
float heightAt(vec2 p){
 ${
   water
     ? 'return -.9+.08*sin(p.x*2.5+uTime*.20)*sin(p.y*1.6-uTime*.12)+.018*sin(p.x*11.+p.y*8.-uTime*.35)*(1.+uAudio.x*.8);'
     : 'return -.85+.30*sin(p.x*.9+p.y*.7)+.20*sin(p.x*1.7-p.y*.25+uTime*.035)+.012*sin(p.x*38.+p.y*9.)*(.6+uAudio.z*.2);'
 }
}
vec3 visualize(vec2 uv){
 vec2 p=screenPoint(uv);vec3 ro=vec3(0.,1.0,3.8),rd=normalize(vec3(p.x*2.6,p.y*2.6-.62,-3.0));
 vec3 bg=background(uv);if(rd.y>=-.03)return bg;
 // Stable projected height field: fine ripples affect normals, never ray-root selection.
 // This avoids discontinuous horizon holes when several distant crests cross one ray.
 float t=(-.85-ro.y)/rd.y;
 vec3 at=ro+rd*t;float e=.008;vec3 n=normalize(vec3(heightAt(at.xz-vec2(e,0.))-heightAt(at.xz+vec2(e,0.)),2.*e,heightAt(at.xz-vec2(0.,e))-heightAt(at.xz+vec2(0.,e))));
 ${
   water
     ? 'vec3 refl=reflect(rd,n);float stripe=exp(-pow((refl.x+.32)*5.,2.))*pow(max(refl.y,0.),.35);vec3 col=mix(uAccent*.08,vec3(.18,.23,.27),.55)+mix(uSecond,vec3(1.,.88,.73),.65)*stripe*(.8+uAudio.y*.20);'
     : 'vec3 sand=mix(vec3(.37,.28,.20),uAccent*.48+vec3(.20),.42);vec3 col=studioLight(n,-rd,sand,.08);col+=(grain(at.xz*1300.)-.5)*.007;'
 }
 return mix(col,bg,1.-exp(-t*t*.025));
}`
const make = (id: string, name: string, description: string, fragment: string): VisualPlugin => ({
  apiVersion: 1,
  id,
  name,
  author: 'B5-Software',
  license: 'GPL-3.0-or-later',
  description,
  fragment,
})
export const STUDIO_PLUGINS: readonly VisualPlugin[] = [
  make('silk-studio', '丝境', '柔光下的缎面雕塑，低频轻轻改变褶皱', silk),
  make('tidal-studio', '潮汐', '安静的水面、宽阔的反射与缓慢涟漪', landscape(true)),
  make('dune-studio', '风痕', '沙丘、细密风纹与柔和远雾', landscape(false)),
  make('glass-studio', '折光', '薄玻璃的曲面、折射与细腻边缘光', glass),
]
export const COVER_PLUGIN = make(
  'cover-studio',
  '封面留白',
  '保留封面与歌词，让音乐自己说话',
  'vec3 visualize(vec2 uv){return background(uv);}'
)
