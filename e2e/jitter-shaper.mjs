import net from 'node:net';
import {fork} from 'node:child_process';
import {createHash} from 'node:crypto';
import {strict as assert} from 'node:assert';
export async function jitterShaperCheck(ok) {
let child, peer, interval;
const server=net.createServer(socket=>{
 peer=socket;let request='';
 socket.once('data',data=>{
  request+=data.toString();
  const key=/Sec-WebSocket-Key: (.+)\r\n/i.exec(request)[1];
  const accept=createHash('sha1').update(key+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+'\r\n\r\n');
  let count=0;
  interval=setInterval(()=>{
   const frame=Buffer.alloc(1925);frame[0]=0x82;frame[1]=126;frame.writeUInt16BE(1921,2);frame.writeUInt32BE(count++,4);
   socket.write(frame.subarray(0,300));
   setTimeout(()=>socket.write(frame.subarray(300)),1);
   if(count===300){clearInterval(interval);setTimeout(()=>socket.end(Buffer.from([0x88,0])),5);}
  },20);
 });
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
try {
 child=fork(new URL('./ws-shaper.mjs',import.meta.url),{execArgv:[],env:{...process.env,SHAPER_HOST:'127.0.0.1',SHAPER_PORT:String(server.address().port),SHAPER_HOST_HEADER:'localhost'},stdio:['ignore','ignore','ignore','ipc']});
 const once=predicate=>new Promise(resolve=>{const listener=d=>{if(predicate(d)){child.off('message',listener);resolve(d)}};child.on('message',listener)});
 const {port}=await once(d=>d.port);
 const ack=once(d=>d.configured);child.send({type:'profile',latency:80,bitsPerSecond:0,jitter:true});await ack;
 const ws=new WebSocket('ws://127.0.0.1:'+port);ws.binaryType='arraybuffer';
 const frames=[],gaps=[];let last;
 await new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>reject(Error('jitter timeout')),12000);
  ws.onmessage=e=>{const now=performance.now();if(last)gaps.push(now-last);last=now;frames.push(new DataView(e.data).getUint32(0));};
  ws.onclose=()=>{clearTimeout(timer);resolve()};ws.onerror=()=>reject(Error('WS chyba'));
 });
 assert.deepEqual(frames,Array.from({length:300},(_,i)=>i));assert.ok(Math.max(...gaps)>=390);
 ok('TCP jitter: 300 celých WS rámců bez ztráty i při dělení těla, opakované prodlevy', {frames:frames.length,maxGapMs:Math.max(...gaps),gapsOver390:gaps.filter(x=>x>=390).length});
} finally {
 clearInterval(interval);peer?.destroy();child?.kill('SIGTERM');await new Promise(r=>server.close(r));
}

}
