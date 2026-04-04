const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');

const server = http.createServer((req,res)=>{
  const html = fs.readFileSync("inferno-pool-test.html");
  res.writeHead(200,{"Content-Type":"text/html"});
  res.end(html);
});

const wss = new WebSocket.Server({ server });

let waiting = null;

function makeBalls(){
  return [{id:0,x:200,y:200,vx:0,vy:0,sunk:false}];
}

function send(ws,data){
  try{ ws.send(JSON.stringify(data)); }catch(e){}
}

wss.on('connection',(ws)=>{
  console.log("CONNECTED");

  if(waiting){
    const p1 = waiting;
    const p2 = ws;

    send(p1,{type:"match"});
    send(p2,{type:"match"});

    waiting = null;
  }else{
    waiting = ws;
    send(ws,{type:"waiting"});
  }

  ws.on('close',()=>console.log("CLOSED"));
  ws.on('error',()=>console.log("ERROR"));
});

server.listen(3000,()=>console.log("RUN http://127.0.0.1:3000"));
