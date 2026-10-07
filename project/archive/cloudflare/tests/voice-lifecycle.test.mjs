import test from 'node:test';
import assert from 'node:assert/strict';
import {Voice} from '../public/voice.js';
import {Conversation} from '../public/conversation.js';

function setup(t){
 t.mock.timers.enable({apis:['setTimeout','setInterval']});
 globalThis.document={addEventListener(){}};
 globalThis.SpeechSynthesisUtterance=class{constructor(text){this.text=text;}};
 const recognizers=[],spoken=[];let cancels=0;
 class Recognition{constructor(){recognizers.push(this);}start(){this.onstart();}stop(){this.stopping=true;}abort(){this.aborted=true;}}
 const synth={speaking:false,pending:false,paused:false,getVoices:()=>[],addEventListener(){},resume(){},cancel(){cancels++;},speak(s){spoken.push(s);this.speaking=true;s.onstart();}};
 globalThis.window={isSecureContext:true,SpeechRecognition:Recognition,speechSynthesis:synth};
 const voice=new Voice();t.after(()=>voice.stop());
 return {voice,recognizers,spoken,synth,cancels:()=>cancels};
}
const result=text=>({results:[Object.assign([{transcript:text}],{isFinal:true})]});
const flush=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};

test('real Voice and Conversation complete five turns without aborting capture or cancelling idle speech',async t=>{
 const h=setup(t);let sends=0;const errors=[];
 const c=new Conversation(h.voice,async()=>{sends++;return {reply:'我在聽，請說。'};},()=>({onText(){}}),e=>errors.push(e));t.after(()=>c.stop());
 c.start('請開始');h.synth.speaking=false;h.spoken[0].onend();t.mock.timers.tick(300);
 for(let i=0;i<5;i++){
   const rec=h.recognizers.at(-1);rec.onresult(result('您好'));assert.equal(sends,i);assert.equal(h.voice.recognition,rec);assert.equal(rec.aborted,undefined);
   rec.onend();rec.onend();await flush();assert.equal(sends,i+1);assert.equal(h.spoken.length,i+2);
   h.synth.speaking=false;h.spoken.at(-1).onend();t.mock.timers.tick(300);assert.equal(h.recognizers.length,i+2);
 }
 assert.deepEqual(errors,[]);assert.equal(h.cancels(),0);
});
test('recognizer missing end aborts with visible error, never sends or hangs',t=>{
 const h=setup(t);const errors=[];let sends=0;
 h.voice.listen(()=>{},e=>errors.push(e),()=>sends++);const rec=h.recognizers[0];rec.onresult(result('你好'));t.mock.timers.tick(4000);
 assert.equal(rec.aborted,true);assert.equal(h.voice.recognition,null);assert.equal(errors.length,1);assert.equal(sends,0);rec.onend();assert.equal(sends,0);
});
test('unexpected aborted error pauses conversation instead of leaving it active forever',t=>{
 const h=setup(t);let error='';const c=new Conversation(h.voice,()=>assert.fail(),()=>({onText(){}}),e=>error=e);c.start();h.recognizers[0].onerror({error:'aborted'});assert.equal(c.active,false);assert.match(error,/中斷/);
});
test('missing speech end recovers only after playback actually started and became idle',t=>{
 const h=setup(t);let done=0;h.voice.speak('您好','',1,()=>done++);
 t.mock.timers.tick(900);assert.equal(done,0);
 h.synth.paused=true;h.synth.speaking=false;t.mock.timers.tick(900);assert.equal(done,0);
 h.synth.paused=false;t.mock.timers.tick(600);assert.equal(done,1);h.spoken[0].onend();assert.equal(done,1);
});
test('stop during final recognition prevents late end from sending or restarting',t=>{
 const h=setup(t);let sends=0;const c=new Conversation(h.voice,()=>sends++,()=>({onText(){}}),()=>{});
 c.start();const rec=h.recognizers[0];rec.onresult(result('您好'));c.stop();rec.onend();t.mock.timers.tick(5000);assert.equal(sends,0);assert.equal(rec.aborted,true);assert.equal(c.active,false);
});

test('second turn silent recognizer retries once, pauses visibly, and reconnect never resends first turn',async t=>{
 const h=setup(t);let sends=0;const errors=[],texts=[];
 const c=new Conversation(h.voice,async()=>{sends++;return {reply:'對，我是。'};},()=>({onText:text=>texts.push(text),playbackReleaseMs:3500}),e=>errors.push(e));t.after(()=>c.stop());
 c.start();h.recognizers[0].onresult(result('請問是王小姐嗎'));h.recognizers[0].onend();await flush();
 h.synth.speaking=false;h.spoken[0].onend();t.mock.timers.tick(3499);assert.equal(h.recognizers.length,1);t.mock.timers.tick(1);
 const stalled=h.recognizers[1];assert.equal(texts.at(-1),'');assert.equal(h.voice.listening,false);
 stalled.onaudiostart();t.mock.timers.tick(12000);assert.equal(stalled.aborted,true);t.mock.timers.tick(600);assert.equal(h.recognizers.length,3);
 stalled.onresult(result('過期文字'));assert.equal(sends,1);
 t.mock.timers.tick(12000);assert.equal(c.active,false);assert.match(errors[0],/重新接通收音/);assert.equal(sends,1);
 c.reconnect();assert.equal(h.recognizers.length,4);assert.equal(h.spoken.length,1);
 h.recognizers[3].onresult(result('我只需要一分鐘'));h.recognizers[3].onend();await flush();assert.equal(sends,2);
});

test('stop during mobile playback release prevents microphone restart',t=>{
 const h=setup(t);const c=new Conversation(h.voice,()=>assert.fail(),()=>({playbackReleaseMs:3500,onText(){}}),()=>{});
 c.start('開始');h.synth.speaking=false;h.spoken[0].onend();c.stop();t.mock.timers.tick(3500);assert.equal(h.recognizers.length,0);
});
