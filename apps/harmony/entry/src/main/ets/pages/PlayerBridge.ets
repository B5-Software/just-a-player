// SPDX-License-Identifier: GPL-3.0-or-later
import { common } from '@kit.AbilityKit';
import { webview } from '@kit.ArkWeb';
import { picker, fileIo as fs } from '@kit.CoreFileKit';
import { usbManager } from '@kit.BasicServicesKit';
import { util } from '@kit.ArkTS';
import { window } from '@kit.ArkUI';
import player from 'libplayer.so';
import BuildProfile from 'BuildProfile';

interface Result { error?: string; }
interface Browse { path?: string; }
interface QaWrite { name:string; data:string; }
interface Fullscreen { value:boolean; }
interface Mode { mode:string; }
interface LightMode { enabled:boolean; }
interface Settings { patch:AwakeSettings; }
interface AwakeSettings { keepScreenAwake?:boolean; }
interface MediaState { state:string; }
export class PlayerBridge {
  private root: string;
  private state: string;
  private pipes: Map<string, usbManager.USBDevicePipe> = new Map();
  private context: common.UIAbilityContext;
  private controller: webview.WebviewController;
  private polling: boolean = false;
  private visible: boolean = true;
  private writeQueue: Promise<string> = Promise.resolve('null');
  private engineQueue: Promise<string> = Promise.resolve('null');
  private keepAwake: boolean = false;
  private playing: boolean = false;
  private awake: boolean = false;
  private lightweight: boolean = false;
  private lightVisuals: boolean = false;
  setLightweight(enabled:boolean):void { this.lightweight=enabled; this.lightVisuals=false; }
  constructor(context: common.UIAbilityContext, controller: webview.WebviewController, snapshot: string) {
    this.context=context;this.controller=controller;
    this.root = context.filesDir; this.state = snapshot.slice(0,-1)+',"qa":'+BuildProfile.DEBUG+'}';
    this.keepAwake = (JSON.parse(snapshot) as Snapshot).settings?.keepScreenAwake ?? false;
  }
  snapshot(): string { return this.state; }
  private emit(key: string, json: string): void {
    // Visibility can arrive before ArkWeb has attached the controller.
    try { this.controller.runJavaScript(`window.__androidEvent?.(${JSON.stringify(key)},${json})`).catch(() => {}); } catch {}
  }
  private async files(method: string, payload: string): Promise<string> {
    const request = `{"op":"files","root":${JSON.stringify(this.root)},"method":${JSON.stringify(method)},"payload":${payload}}`;
    if(method === 'settings' || method === 'librarySave') {
      const operation = this.writeQueue.then(()=>player.request(request));
      this.writeQueue = operation.catch(()=>'null'); return operation;
    }
    return player.request(request);
  }
  engine(message: string): void {
    const operation=this.engineQueue.then(()=>player.request(`{"op":"message","message":${message}}`));
    this.engineQueue=operation.catch(()=>'null');
    operation.then((result: string) => {
      if (result !== 'null') this.emit('engine', result);
    }).catch((e: Error) => this.emit('nativeError', JSON.stringify(e.message)));
  }
  flushLibrary(json: string): void { this.files('librarySave', JSON.stringify({ json: json })); }
  private async importFiles(): Promise<void> {
    const select = new picker.DocumentViewPicker(this.context);
    const options = new picker.DocumentSelectOptions(); options.maxSelectNumber = 100;
    const uris = await select.select(options);
    for (let i = 0; i < uris.length; i++) {
      const file = fs.openSync(uris[i], fs.OpenMode.READ_ONLY);
      try {
        const name = decodeURIComponent(uris[i].split('/').pop() ?? `音频${i}`);
        const result = JSON.parse(await this.files('importFd', JSON.stringify({ fd: file.fd, name: name }))) as Result;
        if (result.error) throw new Error(result.error);
      } finally { fs.closeSync(file); }
    }
  }
  async connectUsb(): Promise<string> {
    const devices = usbManager.getDevices();
    for (let i = 0; i < devices.length; i++) {
      const device = devices[i];
      if (!device.configs.some(config => config.interfaces.some(iface => iface.clazz === 1))) continue;
      if (!await usbManager.requestRight(device.name)) throw new Error('未获得 USB 设备访问授权');
      const pipe = usbManager.connectDevice(device);
      try {
        const fd = usbManager.getFileDescriptor(pipe);
        if (fd < 0) throw new Error('USB 驱动没有返回有效设备句柄');
        const descriptors = new util.Base64Helper().encodeToStringSync(usbManager.getRawDescriptor(pipe));
        const result = JSON.parse(await player.request(JSON.stringify({ op: 'usbAttach', id: device.name, fd: fd, name: device.productName || device.name, descriptors: descriptors, vendor: device.vendorId, product: device.productId }))) as Result;
        if (result.error) throw new Error(result.error);
        this.pipes.set(device.name, pipe); this.emit('usb', 'true');
        return `已连接 ${device.productName || device.name}；按设备描述符与实际时钟协商`;
      } catch (e) { usbManager.closePipe(pipe); throw new Error((e as Error).message); }
    }
    throw new Error('未发现 USB Audio 设备；模拟器无法替代真实 DAC 直通验证');
  }
  request(id: number, method: string, payload: string): void {
    this.work(method, payload).then((result: string) => {
      const error = JSON.parse(result) as Result;
      this.emit('rpc', error?.error ? JSON.stringify({ id: id, error: error.error }) : `{"id":${id},"value":${result}}`);
    }).catch((e: Error) => this.emit('rpc', JSON.stringify({ id: id, error: e.message })));
  }
  private async work(method: string, payload: string): Promise<string> {
    if(method === 'lightVisuals') { this.lightVisuals=(JSON.parse(payload) as LightMode).enabled;return 'null'; }
    if(method === 'lightweightMode') {
      const result=await this.files(method,payload);
      this.setLightweight((JSON.parse(payload) as LightMode).enabled);
      setTimeout(()=>AppStorage.setOrCreate('japNativeMode',this.lightweight),120);
      return result;
    }
    if(method==='qaWrite') {
      if(!BuildProfile.DEBUG)throw new Error('Test operation unavailable');
      const input=JSON.parse(payload) as QaWrite;
      if(!/^[a-zA-Z0-9_.-]{1,100}$/.test(input.name)||input.data.length>12*1024*1024)throw new Error('Invalid test fixture');
      const path=this.root+'/Music/'+input.name;
      const file=fs.openSync(path,fs.OpenMode.CREATE|fs.OpenMode.WRITE_ONLY|fs.OpenMode.TRUNC);
      try{fs.writeSync(file.fd,new util.Base64Helper().decodeSync(input.data).buffer as ArrayBuffer)}finally{fs.closeSync(file)}
      return JSON.stringify(path);
    }
    if (method === 'connectUsb') return JSON.stringify(await this.connectUsb());
    if(method === 'settings') {
      this.keepAwake = (JSON.parse(payload) as Settings).patch.keepScreenAwake ?? false;
      await this.updateAwake();
      const result = await this.files(method,payload);
      const snapshot = JSON.parse(this.state) as Snapshot;
      snapshot.settings = JSON.parse(result) as AwakeSettings;
      this.state = JSON.stringify(snapshot);
      return result;
    }
    if(method === 'systemMedia') {
      this.playing = (JSON.parse(payload) as MediaState).state === 'playing';
      await this.updateAwake(); return 'null';
    }
    if (method === 'browse' && (JSON.parse(payload) as Browse).path === 'native-import') {
      await this.importFiles(); return this.files('browse', '{}');
    }
    if (method === 'fullscreen') {
      const value = (JSON.parse(payload) as Fullscreen).value;
      const current = await window.getLastWindow(this.context);
      if(value) await current.maximize(window.MaximizePresentation.ENTER_IMMERSIVE); else await current.recover();
      this.emit('fullscreen',JSON.stringify(value)); return JSON.stringify(value);
    }
    if (method === 'windowMode') {
      const mode = (JSON.parse(payload) as Mode).mode;
      const current = await window.getLastWindow(this.context);
      await current.recover();
      if(mode === 'mini')await current.resize(480,270);
      else await current.resize(1280,800);
      this.emit('windowMode',JSON.stringify(mode)); return JSON.stringify(mode);
    }
    return this.files(method, payload);
  }
  poll(): void {
    if(this.polling||this.lightweight)return;
    this.polling=true;
    player.request(`{"op":"poll","visual":${this.visible && (!this.lightweight || this.lightVisuals)}}`).then((events: string) => {
      if(events === '[]')return;
      return this.controller.runJavaScript(`for(const event of ${events})window.__androidEvent?.('engine',event.kind?event:{kind:'event',event})`);
    }).catch(()=>{}).finally(()=>{this.polling=false;});
  }
  private async updateAwake():Promise<void> {
    const awake=this.keepAwake && this.playing && this.visible;
    if(awake===this.awake)return;
    const current=await window.getLastWindow(this.context); await current.setWindowKeepScreenOn(awake);this.awake=awake;
  }
  setVisible(visible:boolean):void { this.visible=visible;this.updateAwake().catch(()=>{});this.emit('visibility',JSON.stringify(visible)); }
}
interface Snapshot { settings?:AwakeSettings; }
