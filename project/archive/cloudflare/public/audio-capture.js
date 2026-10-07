export function pcmWav(samples, rate=16000) {
  const buffer=new ArrayBuffer(44+samples.length*2),v=new DataView(buffer);
  const str=(o,s)=>{for(let i=0;i<s.length;i++)v.setUint8(o+i,s.charCodeAt(i));};
  str(0,'RIFF');v.setUint32(4,buffer.byteLength-8,true);str(8,'WAVE');str(12,'fmt ');v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);v.setUint32(24,rate,true);v.setUint32(28,rate*2,true);v.setUint16(32,2,true);v.setUint16(34,16,true);str(36,'data');v.setUint32(40,samples.length*2,true);
  samples.forEach((x,i)=>v.setInt16(44+i*2,Math.max(-1,Math.min(1,x))*32767,true));
  return new Uint8Array(buffer);
}
export class AudioCapture {
  constructor(){this.epoch=0;}
  cancel(){this.epoch++;this.node?.disconnect();this.source?.disconnect();this.stream?.getTracks().forEach(t=>t.stop());this.context?.close().catch(()=>{});this.node=this.source=this.stream=this.context=null;this.chunks=[];}
  async start(){
    this.cancel();const epoch=this.epoch;
    const stream=await navigator.mediaDevices.getUserMedia({audio:{channelCount:1,echoCancellation:true},video:false});
    if(epoch!==this.epoch){stream.getTracks().forEach(t=>t.stop());return false;}
    this.stream=stream;
    try{
      const context=new AudioContext({sampleRate:16000});this.context=context;
      await context.audioWorklet.addModule('./audio-worklet.js');
      if(epoch!==this.epoch)return false;
      await context.resume();if(epoch!==this.epoch)return false;
      if(context.sampleRate!==16000)throw new Error('此瀏覽器未支援評分錄音格式，請取消本場聲音評估後繼續對話。');
      this.rate=context.sampleRate;this.chunks=[];this.count=0;
      this.node=new AudioWorkletNode(context,'hao-capture');
      this.node.port.onmessage=({data})=>{if(epoch===this.epoch&&this.count+data.length<=this.rate*45){this.chunks.push(data);this.count+=data.length;}};
      this.source=context.createMediaStreamSource(stream);this.source.connect(this.node);this.node.connect(context.destination);return true;
    }catch(e){if(epoch===this.epoch)this.cancel();throw e;}
  }
  finish(){
    const chunks=this.chunks||[],rate=this.rate, count=chunks.reduce((n,c)=>n+c.length,0);
    this.cancel();if(!count)return null;
    const samples=new Float32Array(count);let offset=0;for(const chunk of chunks){samples.set(chunk,offset);offset+=chunk.length;}
    const bytes=pcmWav(samples,rate);let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
    return {mimeType:'audio/wav',data:btoa(binary),duration:count/rate};
  }
}
