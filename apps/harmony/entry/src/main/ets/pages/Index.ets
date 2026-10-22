// SPDX-License-Identifier: GPL-3.0-or-later
import { common } from '@kit.AbilityKit';
import { webview } from '@kit.ArkWeb';
import player from 'libplayer.so';
import { PlayerBridge } from './PlayerBridge';
import BuildProfile from 'BuildProfile';

@Entry
@Component
struct Index {
  private controller: webview.WebviewController = new webview.WebviewController();
  private proxy: PlayerBridge = new PlayerBridge(getContext(this) as common.UIAbilityContext, this.controller, '{}');
  private timer: number = -1;
  @State private ready: boolean = false;
  @State private failure: string = '';
  @StorageLink('japVisible') @Watch('visibilityChanged') private visible:boolean = true;
  private visibilityChanged():void { this.proxy.setVisible(this.visible); }
  aboutToAppear(): void {
    webview.WebviewController.setWebDebuggingAccess(BuildProfile.DEBUG);
    const context = getContext(this) as common.UIAbilityContext;
    player.request('{"op":"init"}').then(() => player.request(`{"op":"files","root":${JSON.stringify(context.filesDir)},"method":"snapshot","payload":{}}`)).then((snapshot: string) => {
      this.proxy = new PlayerBridge(context, this.controller, snapshot);
      this.ready = true;
    }).catch((e: Error) => { this.failure = e.message; });
  }
  aboutToDisappear(): void { if (this.timer >= 0) clearInterval(this.timer); }
  onPageShow():void { this.proxy.setVisible(true); }
  onPageHide():void { this.proxy.setVisible(false); }
  private resource(url: string): WebResourceResponse {
    const response = new WebResourceResponse();
    if(!url.startsWith('https://jap.localhost/')) return response;
    const name = decodeURIComponent(url.slice('https://jap.localhost/'.length).split('?')[0]) || 'index.html';
    try {
      if(name.split('/').some(part=>part==='..')) throw new Error('Invalid asset path');
      const context=getContext(this) as common.UIAbilityContext;
      const data=context.resourceManager.getRawFileContentSync('web/'+name);
      response.setResponseData(data.buffer as ArrayBuffer);
      response.setResponseCode(200);response.setReasonMessage('OK');response.setResponseEncoding('UTF-8');
      const ext=name.split('.').pop() ?? '';
      let mime='application/octet-stream';
      if(ext==='html')mime='text/html';else if(ext==='js')mime='application/javascript';else if(ext==='css')mime='text/css';else if(ext==='woff2')mime='font/woff2';else if(ext==='png')mime='image/png';else if(ext==='jpg'||ext==='jpeg')mime='image/jpeg';else if(ext==='glsl')mime='text/plain';else if(ext==='svg')mime='image/svg+xml';
      response.setResponseMimeType(mime);
    } catch {
      response.setResponseCode(name==='favicon.ico'?204:404);response.setReasonMessage(name==='favicon.ico'?'No Content':'Not Found');response.setResponseData('');
    }
    return response;
  }
  build() {
    Stack() {
      if (this.ready) {
        Web({ src: 'https://jap.localhost/index.html', controller: this.controller })
          .javaScriptAccess(true).domStorageAccess(true).fileAccess(true)
          .javaScriptProxy({ object: this.proxy, name: 'NativeHarmony', methodList: ['snapshot','request','engine','flushLibrary'], controller: this.controller })
          .onPageEnd(() => { this.proxy.setVisible(this.visible);if(this.timer >= 0) clearInterval(this.timer); this.timer = setInterval(() => this.proxy.poll(), 33); })
          .onInterceptRequest((event)=>this.resource(event?.request.getRequestUrl() ?? ''))
          .onOverrideUrlLoading((request) => !request.getRequestUrl().startsWith('https://jap.localhost/'))
          .width('100%').height('100%')
      } else {
        Column({space:16}) {
          Text('Just A Player').fontSize(28).fontWeight(FontWeight.Medium).fontColor('#d9d6ff')
          if(this.failure) {Text(this.failure).fontSize(14).fontColor('#e4dae8')} else {LoadingProgress().width(36).height(36).color('#8476ff')}
        }.padding(32)
      }
    }.width('100%').height('100%').backgroundColor('#11121c')
  }
}
