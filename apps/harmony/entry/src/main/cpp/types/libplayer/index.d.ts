export const request: (json: string) => Promise<string>;
export const nativeRender: (width:number,height:number,input:string) => { pixels:ArrayBuffer;state:string };
