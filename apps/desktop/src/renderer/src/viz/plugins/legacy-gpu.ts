/** Portable versions of the legacy themes. One shader definition for SDR, native HDR and export. */
import type { VisualPlugin } from '@shared/visual-plugin'
import { LEGACY_VISUALS } from '@shared/visual-builtins'
import { shaderScene } from './shader'
import { audioDriver, AUDIO_UNIFORMS, instrumentDriver, vuDriver } from './audio-driver'

const vu = `
uniform vec4 uVu;uniform highp sampler2D uVuLabels;
float vuSegment(vec2 p,vec2 a,vec2 b){vec2 d=b-a;return length(p-a-d*clamp(dot(p-a,d)/max(.00001,dot(d,d)),0.,1.));}
vec3 visualize(vec2 uv){
 vec3 col=background(uv)*.6,ink=mix(vec3(.72,.76,.81),uAccent,.2);float label=texture(uVuLabels,vec2(uv.x,1.-uv.y)).r;col=mix(col,ink,label);
 for(int ch=0;ch<2;ch++){
  vec2 p=(uv-vec2(ch==0?.28:.72,.38))*vec2(uRes.x/uRes.y,1.);float r=length(p),a=atan(p.y,p.x),aa=1.5/uRes.y;
  float arc=(1.-smoothstep(aa,aa*2.,abs(r-.21)))*step(.58,a)*step(a,2.56);
  col+=ink*arc*.45;
  for(int i=0;i<10;i++){
   float db=float(i)-7.;if(i==0)db=-20.;if(i==1)db=-10.;if(i==2)db=-7.;if(i==3)db=-5.;if(i==4)db=-3.;if(i==5)db=-1.;if(i==6)db=0.;if(i==7)db=1.;if(i==8)db=2.;if(i==9)db=3.;
   float at=2.55-pow(10.,(db-3.)/20.)*1.96;vec2 d=vec2(cos(at),sin(at));float tick=1.-smoothstep(aa,aa*2.,vuSegment(p,d*.218,d*.232));col+=mix(ink,uSecond,step(0.,db))*tick*.8;
  }
  float v=ch==0?uVu.x:uVu.y,peak=ch==0?uVu.z:uVu.w;
  float angle=2.55-v*1.96;vec2 tip=vec2(cos(angle),sin(angle))*.205;
  float needle=1.-smoothstep(aa*.65,aa*1.8,vuSegment(p,vec2(0.),tip));col+=uAccent*needle*1.5;
  float h=2.55-peak*1.96;float mark=1.-smoothstep(aa,aa*2.,vuSegment(p,vec2(cos(h),sin(h))*.236,vec2(cos(h),sin(h))*.245));col+=uSecond*mark*.7;
  float hub=1.-smoothstep(.007,.011,r);col=mix(col,ink*.65,hub);
 }
 return col;
}`

const sphere = (plasma: boolean): string => `
float field(vec3 p){
 p.xz=rotate(uTime*.10)*p.xz;
 float fold=sin(p.x*3.1+uTime*.21)*sin(p.y*4.2-uTime*.16)*cos(p.z*3.4);
 return length(p)-.87-fold*(.055+uAudio.x*.22)-band(clamp(p.y*.45+.5,0.,1.))*.07;
}
vec3 visualize(vec2 uv){
 vec2 p=screenPoint(uv)*3.;vec3 bg=background(uv),ro=vec3(uPointer.x*.12,uPointer.y*.08,3.6),rd=normalize(vec3(p,-3.6));
 vec2 ep=p*vec2(1.,2.25);float r=length(ep),angle=atan(ep.y,ep.x)/6.2831853+.5;
 float strength=band(abs(angle*2.-1.));float ring=1.-smoothstep(.008,.022,abs(r-1.45));
 float bars=(1.-smoothstep(.02,.055,abs(fract(angle*96.)-.5)))*(1.-smoothstep(.01,.025,abs(r-(1.51+strength*.15))-.025-strength*.13));
 bg+=mix(uAccent,uSecond,angle)*(ring*.48+bars*.65);
 float b=dot(ro,rd),disc=b*b-dot(ro,ro)+1.7;
 if(disc<0.)return bg;float t=max(0.,-b-sqrt(disc)),d=0.;
 for(int i=0;i<48;i++){d=field(ro+rd*t);if(abs(d)<.0015||t>6.)break;t+=max(abs(d)*.7,.001);}
 if(t>6.||abs(d)>.009)return bg;
 vec3 at=ro+rd*t;vec2 e=vec2(.003,0.);vec3 n=normalize(vec3(field(at+e.xyy)-field(at-e.xyy),field(at+e.yxy)-field(at-e.yxy),field(at+e.yyx)-field(at-e.yyx)));
 float rim=pow(1.-max(dot(n,-rd),0.),2.7);
 ${plasma ? 'vec3 col=mix(uAccent,uSecond,.5+.5*sin(at.y*6.+at.x*3.-uTime*.18))*(.15+rim*2.2)+vec3(.65,.42,.23)*pow(max(0.,sin(at.x*6.+at.y*4.+uTime*.3)),10.)*(.25+uAudio.y);' : 'vec3 col=studioLight(n,-rd,mix(vec3(.035,.045,.06),uAccent*.16,.6),.5)+uSecond*rim*.65;'}
 return mix(bg,col,1.-smoothstep(.001,.009,abs(d)));
}`
const galaxy = `
vec3 visualize(vec2 uv){
 vec2 p=screenPoint(uv)*2.0;p=rotate(-.30)*p;p.y*=2.;
 vec3 col=background(uv);float r=length(p),a=atan(p.y,p.x);
 float spiral=.5+.5*cos(a*3.-r*5.+uTime*.10);
 float density=pow(spiral,14.)*exp(-r*1.3)*smoothstep(.05,.32,r);
 col+=mix(uAccent,uSecond,clamp(r*.7,0.,1.))*density*(.10+uAudio.y*.35);
 for(int layer=0;layer<3;layer++){
  float scale=85.+float(layer)*47.;vec2 cell=floor(p*scale),q=fract(p*scale)-.5;
  float seed=grain(cell+float(layer)*53.);vec2 offset=vec2(grain(cell+7.),grain(cell+31.))-.5;
  float star=exp(-dot(q-offset*.65,q-offset*.65)/(0.004+uAudio.z*.006));
  star*=step(.82,seed)*(.08+density*2.5)*exp(-r*.45);
  col+=mix(uAccent,uSecond,seed)*star*(.4+band(clamp(r*.5,0.,1.)));
 }
 col+=mix(uAccent,vec3(1.,.93,.80),.7)*exp(-r*r*95.)*.8;
 return col;
}`
const tunnel = `
vec3 visualize(vec2 uv){vec2 p=screenPoint(uv)*2.2-uPointer*.07;float r=length(p),angle=atan(p.y,p.x)/6.2831853+.5;
 float depth=-log(max(.008,r))*3.5+uTime*.30;float grid=abs(fract(depth)-.5);
 float aa=max(.015,fwidth(depth)*1.3);float rings=1.-smoothstep(.018,.018+aa,grid);
 float lanes=1.-smoothstep(.01,.01+max(.015,fwidth(angle*32.)),abs(fract(angle*32.)-.5));
 float pulse=band(abs(angle*2.-1.));vec3 col=background(uv);
 col+=mix(uAccent,uSecond,fract(depth*.17))*(rings*(.10+pulse*.8)+lanes*.025)*smoothstep(0.,.07,r)*exp(-r*.85);
 return col;}`
const city = `
float building(vec3 p){vec2 id=floor(p.xz),q=fract(p.xz)-.5;float height=.22+grain(id)*1.7+band(grain(id+4.))*.8;return max(max(abs(q.x)-.25,abs(q.y)-.25),abs(p.y-height*.5)-height*.5);}
vec3 visualize(vec2 uv){vec2 p=screenPoint(uv);vec3 ro=vec3(3.2,2.8,4.7),rd=normalize(vec3(p.x*3.4-1.8,p.y*3.4-1.8,-3.5));rd.xz=rotate(uPointer.x*.12)*rd.xz;
 vec3 col=background(uv);float t=0.,d=0.;vec3 at=ro;
 for(int i=0;i<52;i++){at=ro+rd*t;d=min(building(at),at.y);if(abs(d)<.003||t>14.)break;t+=max(abs(d)*.75,.005);}
 if(t>14.)return col;
 vec3 ink=mix(uAccent,uSecond,grain(floor(at.xz)));
 if(at.y<.012){float grid=min(abs(fract(at.x)-.5),abs(fract(at.z)-.5));col+=uSecond*.025/(.03+grid)*exp(-t*.12);}
 else{vec2 windows=fract(vec2(at.x+at.z,at.y)*vec2(12.,10.));float glow=step(.60,grain(floor(vec2(at.x+at.z,at.y)*vec2(12.,10.))))*smoothstep(.1,.22,windows.x)*(1.-smoothstep(.6,.75,windows.x))*smoothstep(.1,.25,windows.y)*(1.-smoothstep(.6,.75,windows.y));col=mix(col,ink*(.035+glow*(.9+uAudio.x)),exp(-t*.10));}
 return col;}`
const ribbon = `
float ribbonLine(vec2 p,float y,float w){float d=abs(p.y-y);return 1.-smoothstep(w,w*2.5,d)+exp(-d*65.)*.08;}
vec3 visualize(vec2 uv){vec2 p=screenPoint(uv)*2.8;vec3 col=background(uv);
 if(abs(p.x)>1.65)return col;
 float x=clamp(p.x/1.65,-.99999,.99999),arc=sqrt(max(.00002,1.-x*x)),w=max(.004,1.5/uRes.y);
 vec2 pair=stereo(int(clamp(x*.5+.5,0.,1.)*127.));float flutter=sin(p.x*3.2+uTime*.17)*.12;
 float upper=arc*.55+pair.x*.17+flutter,lower=-arc*.55+pair.y*.17-flutter;
 col+=uAccent*(.45+.4*arc)*ribbonLine(p,upper,w);
 col+=uSecond*(.45-.4*arc)*ribbonLine(p,lower,w);
 return col;}`
const terrain = `
float heightAt(vec2 p){float f=clamp(abs(p.x)*.22,0.,1.);return -.7+band(f)*(.35+.16*sin(p.y*1.3+uTime*.12))+.055*sin(p.x*2.+p.y*.7);}
vec3 visualize(vec2 uv){vec2 p=screenPoint(uv);vec3 bg=background(uv),ro=vec3(0.,1.1,3.8),rd=normalize(vec3(p.x*3.,p.y*3.-.55,-3.5));if(rd.y>-.03)return bg;
 float t=(-.7-ro.y)/rd.y;vec3 at=ro+rd*t;float h=heightAt(at.xz),e=.02;vec3 n=normalize(vec3(heightAt(at.xz-vec2(e,0.))-heightAt(at.xz+vec2(e,0.)),2.*e,heightAt(at.xz-vec2(0.,e))-heightAt(at.xz+vec2(0.,e))));
 vec2 g=at.xz*2.,f=abs(fract(g)-.5);vec2 width=max(fwidth(g),vec2(.004));float line=1.-min(smoothstep(vec2(.01),width*1.5+vec2(.01),f).x,smoothstep(vec2(.01),width*1.5+vec2(.01),f).y);
 vec3 col=studioLight(n,-rd,mix(uAccent*.08,uSecond*.22,clamp(h+1.,0.,1.)),.12)+mix(uAccent,uSecond,.6)*line*.18;
 return mix(col,bg,1.-exp(-t*t*.018));}`

const INSTRUMENT_LIBRARY = `
uniform vec4 uPlot;uniform highp sampler2D uLabels;uniform highp sampler2D uHistory;uniform float uHistoryHead;
float segment(vec2 p,vec2 a,vec2 b){vec2 q=p-a,v=b-a;return length(q-v*clamp(dot(q,v)/dot(v,v),0.,1.));}
float digit(vec2 p,int n){int masks[10]=int[10](63,6,91,79,102,109,125,7,127,111);int mask=masks[clamp(n,0,9)];float d=2.;
 if((mask&1)!=0)d=min(d,segment(p,vec2(.1,.95),vec2(.5,.95)));
 if((mask&2)!=0)d=min(d,segment(p,vec2(.55,.9),vec2(.55,.55)));
 if((mask&4)!=0)d=min(d,segment(p,vec2(.55,.45),vec2(.55,.1)));
 if((mask&8)!=0)d=min(d,segment(p,vec2(.1,.05),vec2(.5,.05)));
 if((mask&16)!=0)d=min(d,segment(p,vec2(.05,.1),vec2(.05,.45)));
 if((mask&32)!=0)d=min(d,segment(p,vec2(.05,.55),vec2(.05,.9)));
 if((mask&64)!=0)d=min(d,segment(p,vec2(.1,.5),vec2(.5,.5)));
 return 1.-smoothstep(.025,.075,d);
}
float reading(vec2 p,float amp){if(p.x<-.2||p.x>3.2||p.y<-.2||p.y>1.2)return 0.;float v=clamp(-20.*log(max(amp,.00001))/log(10.),0.,99.9);int n=int(v*10.+.5);float ink=1.-smoothstep(.02,.07,segment(p,vec2(.05,.5),vec2(.35,.5)));p.x-=.5;ink=max(ink,digit(p,n/100));p.x-=.72;ink=max(ink,digit(p,(n/10)%10));p.x-=.72;ink=max(ink,1.-smoothstep(.025,.07,length(p-vec2(.03,.06))));p.x-=.18;return max(ink,digit(p,n%10));}
vec3 visualize(vec2 uv){vec3 bg=background(uv)*.68,ink=mix(uAccent,vec3(.72,.78,.85),.8);float mask=texture(uLabels,vec2(uv.x,1.-uv.y)).r;vec3 col=mix(bg,ink,mask);
 vec2 q=(uv-uPlot.xy)/uPlot.zw;float px=1./max(1.,uRes.y*uPlot.w);
 float numbers=reading((uv-vec2(.075,.215))*uRes/18.,uLevel.x)+reading((uv-vec2(.275,.215))*uRes/18.,uLevel.y)+reading((uv-vec2(.525,.215))*uRes/18.,uLevel.z)+reading((uv-vec2(.725,.215))*uRes/18.,uLevel.w);col=mix(col,ink,clamp(numbers,0.,1.));
 if(q.x<0.||q.x>1.||q.y<0.||q.y>1.)return col;
 vec2 g=abs(fract(q*vec2(10.,4.))-.5);float grid=1.-smoothstep(.005,.018,min(g.x,g.y));col+=ink*grid*.045;
 BODY
 return col;}
`
const instruments: Record<string, string> = {
  scope: `float y=.5+wave(q.x)*.43;float line=1.-smoothstep(px,px*2.8,abs(q.y-y));col+=mix(uAccent,uSecond,q.x)*line*1.5;`,
  spectrum: `float value=band(q.x);float line=1.-smoothstep(px,px*2.5,abs(q.y-value));float peak=(1.-smoothstep(px*.6,px*1.5,abs(q.y-held(q.x))))*.28;float fill=(1.-smoothstep(value,value+px,q.y))*.13;col+=mix(uAccent,uSecond,q.x)*(fill+line*1.6+peak);`,
  spectrogram: `float row=mod(uHistoryHead-(1.-q.y)*95.+96.,96.);float energy=texture(uHistory,vec2(q.x,(row+.5)/96.)).r;vec3 heat=mix(uAccent*.25,uSecond*1.6,smoothstep(.35,.95,energy));col+=heat*pow(energy,.9);`,
  vectorscope: `vec2 point=(q-.5)*vec2(uRes.x*uPlot.z/(uRes.y*uPlot.w),1.)+.5;if(point.x>=0.&&point.x<=1.){float density=texture(uHistory,point).r;col+=mix(uAccent,uSecond,q.y)*density*1.6;}`,
}
const themes: Record<string, string> = {
  orb: sphere(false),
  galaxy,
  tunnel,
  city,
  ribbon,
  plasma: sphere(true),
  terrain,
}
export const legacyGpuScenes = LEGACY_VISUALS.map((def) => {
  const instrument = instruments[def.id]
  const plugin: VisualPlugin = {
    apiVersion: 1,
    id: def.id,
    name: def.name,
    description: def.hint,
    author: 'B5-Software',
    license: 'GPL-3.0-or-later',
    fragment:
      AUDIO_UNIFORMS +
      (def.id === 'vu'
        ? vu
        : instrument
          ? INSTRUMENT_LIBRARY.replace('BODY', instrument)
          : themes[def.id]),
  }
  return shaderScene(
    plugin,
    false,
    def.id === 'vu'
      ? vuDriver
      : instrument
        ? () => instrumentDriver(def.id, def.name)
        : () => audioDriver(false, def.id === 'ribbon')
  )
})
