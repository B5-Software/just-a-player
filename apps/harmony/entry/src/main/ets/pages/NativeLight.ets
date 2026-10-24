// SPDX-License-Identifier: GPL-3.0-or-later
import { common } from '@kit.AbilityKit';
import { image } from '@kit.ImageKit';
import { picker, fileIo as fs } from '@kit.CoreFileKit';
import { window } from '@kit.ArkUI';
import player from 'libplayer.so';
import BuildProfile from 'BuildProfile';

interface NativeEvent { type:string;x?:number;y?:number;dy?:number;text?:string; }
interface NativeSettings { keepScreenAwake?:boolean; }
interface NativeMedia { state:string; }
interface NativeAction { type:string;handoff?:Object;settings?:NativeSettings;value?:NativeMedia; }
interface SwitchPayload { enabled:boolean;handoff?:Object; }
interface SettingsPayload { patch?:NativeSettings; }
interface ImportPayload { fd:number;name:string; }
interface ImportInput { type:string;paths:string[]; }
interface EditInput { type:string;text:string; }
interface SettingsSnapshot { settings:NativeSettings; }

interface NativeFrame { actions:NativeAction[];keyboard:boolean;visual:boolean;playing:boolean;error?:string;debug?:Object;textField?:string;textValue?:string; }
interface NativePixels { pixels:ArrayBuffer;state:string; }
@Component
export struct NativeLight {
  @State private picture:image.PixelMap|undefined=undefined;
  @StorageLink('japVisible') private visible:boolean=true;
  private timer:number=-1;
  private initialized:boolean=false;
  private closing:boolean=false;
  private surfaceWidth:number=1280;
  private surfaceHeight:number=720;
  private events:NativeEvent[]=[];
  private lastY:number=0;
  private downX:number=0;
  private downY:number=0;
  private scrolling:boolean=false;
  private drawing:boolean=false;
  private interval:number=200;
  private keepAwake:boolean=false;
  private playing:boolean=false;
  private context:common.UIAbilityContext=getContext(this) as common.UIAbilityContext;
  onUsb:()=>Promise<void>=async()=>{};
  @State private failure:string='';
  @State private qaDescription:string='';
  @State private inputValue:string='';
  private keyboard:boolean=false;
  private textField:string='';
  private inputController:TextInputController=new TextInputController();
  aboutToAppear():void {
    player.request(JSON.stringify({op:'nativeInit',root:this.context.filesDir,qa:BuildProfile.DEBUG})).then(()=>{
      player.request(JSON.stringify({op:'files',root:this.context.filesDir,method:'snapshot',payload:null})).then((snapshot:string)=>{this.keepAwake=(JSON.parse(snapshot) as SettingsSnapshot).settings?.keepScreenAwake??false;});
      this.initialized=true;this.next();
    }).catch((e:Error)=>this.failure=e.message);
  }
  aboutToDisappear():void {this.closing=true;if(this.timer>=0)clearTimeout(this.timer);this.picture?.release();}
  private next():void {if(this.closing)return;this.timer=setTimeout(()=>{this.draw();this.next();},this.interval);}
  private async draw():Promise<void>{
    if(!this.initialized||this.closing||this.drawing)return;
    if(!this.visible){await player.request('{"op":"nativeTick","visible":false}');return;}
    this.drawing=true;
    try{
      const scale=Math.min(1,1600/this.surfaceWidth,1000/this.surfaceHeight);
      const width=Math.max(160,Math.round(this.surfaceWidth*scale)),height=Math.max(90,Math.round(this.surfaceHeight*scale));
      const frame=player.nativeRender(width,height,JSON.stringify({width:width,height:height,visible:this.visible,events:this.events})) as NativePixels;
      this.events=[];
      const state=JSON.parse(frame.state) as NativeFrame;
      if(state.error)throw new Error(state.error);
      this.interval=state.visual?34:200;
      if(BuildProfile.DEBUG)this.qaDescription=JSON.stringify(state.debug);
      if(state.keyboard&&(!this.keyboard||this.textField!==state.textField)){
        this.inputValue=state.textValue??'';this.textField=state.textField??'';
        setTimeout(()=>focusControl.requestFocus('native-ime'),30);
      }else if(!state.keyboard&&this.keyboard)this.inputController.stopEditing();
      this.keyboard=state.keyboard;

      const next=await image.createPixelMap(frame.pixels,{size:{width:width,height:height},pixelFormat:image.PixelMapFormat.RGBA_8888,alphaType:image.AlphaType.OPAQUE});
      if(this.closing){next.release();return;}
      const old=this.picture;this.picture=next;if(old)setTimeout(()=>old.release(),100);
      for(const action of state.actions)await this.action(action);
    }catch(e){this.failure=(e as Error).message;}
    finally{this.drawing=false;if(this.events.length&&this.visible&&!this.closing)this.draw();}
  }
  private async action(action:NativeAction):Promise<void>{
    if(action.type==='returnFull'){
      await player.request(JSON.stringify({op:'files',root:this.context.filesDir,method:'lightweightMode',payload:{enabled:false,handoff:action.handoff} as SwitchPayload}));
      await player.request('{"op":"nativeControl","input":{"type":"close"}}');
      AppStorage.setOrCreate('japNativeMode',false);
    }else if(action.type==='settings'){
      await player.request(JSON.stringify({op:'files',root:this.context.filesDir,method:'settings',payload:{patch:action.settings} as SettingsPayload}));this.keepAwake=action.settings?.keepScreenAwake??false;
    }else if(action.type==='importPicker'){
      const select=new picker.DocumentViewPicker(this.context),options=new picker.DocumentSelectOptions();
      options.maxSelectNumber=100;
      const uris=await select.select(options);
      for(const uri of uris){
        const file=fs.openSync(uri,fs.OpenMode.READ_ONLY);
        try{await player.request(JSON.stringify({op:'files',root:this.context.filesDir,method:'importFd',payload:{fd:file.fd,name:decodeURIComponent(uri.split('/').pop()??'audio')} as ImportPayload}));}finally{fs.closeSync(file);}
      }
      const paths=JSON.parse(await player.request(JSON.stringify({op:'files',root:this.context.filesDir,method:'takeOpenFiles',payload:null}))) as string[];
      await player.request(JSON.stringify({op:'nativeControl',input:{type:'import',paths:paths} as ImportInput}));
    }else if(action.type==='media'){
      // The native audio host stays alive; keep-awake follows its actual state.
      const current=await window.getLastWindow(this.context);
      // General setting is applied by the full bridge as well.
      this.playing=action.value?.state==='playing';
      current.setWindowKeepScreenOn(this.keepAwake&&this.playing&&this.visible);
    }else if(action.type==='usb'){
      await this.onUsb();
    }
  }
  build(){
    Stack(){
      if(this.picture){
        Image(this.picture).objectFit(ImageFit.Fill).width('100%').height('100%')
          .accessibilityText('Just A Player Rust native player').accessibilityDescription(BuildProfile.DEBUG?this.qaDescription:'Rust 原生音乐播放器')
          .onAreaChange((_old,area)=>{this.surfaceWidth=Math.max(160,vp2px(Number(area.width)));this.surfaceHeight=Math.max(90,vp2px(Number(area.height)));})
          .onTouch((event:TouchEvent)=>{
            const touch=event.touches[0]??event.changedTouches[0];if(!touch)return;
            const x=vp2px(touch.x)/this.surfaceWidth,y=vp2px(touch.y)/this.surfaceHeight;
            if(event.type===TouchType.Down){this.downX=x;this.downY=this.lastY=y;this.scrolling=false;this.events.push({type:'down',x:x,y:y});}
            else if(event.type===TouchType.Move){
              if(!this.scrolling&&Math.abs(y-this.downY)>0.02&&Math.abs(y-this.downY)>Math.abs(x-this.downX)*1.3){this.scrolling=true;this.events.push({type:'cancel',x:x,y:y});}
              if(this.scrolling)this.events.push({type:'scroll',x:x,y:y,dy:(y-this.lastY)*540});else this.events.push({type:'move',x:x,y:y});this.lastY=y;
            }else {if(!this.scrolling)this.events.push({type:event.type===TouchType.Up?'up':'cancel',x:x,y:y});this.scrolling=false;}
            this.draw();
          })
      }else{Text('Just A Player · Native').fontColor('#d9d6ff').fontSize(24)}
      TextInput({text:this.inputValue,controller:this.inputController}).id('native-ime').width(1).height(1).opacity(0.01).position({x:0,y:0})
        .onChange((value:string)=>{if(!this.keyboard)return;this.inputValue=value;player.request(JSON.stringify({op:'nativeControl',input:{type:'edit',text:value} as EditInput})).then(()=>this.draw());})
      if(this.failure){Text(this.failure).fontColor('#e4dae8').fontSize(14).padding(20).backgroundColor('#252033').borderRadius(16).onClick(()=>this.failure='')}
    }.width('100%').height('100%').backgroundColor('#13121a')
  }
}
