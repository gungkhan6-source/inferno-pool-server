const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');

// HTTP SERVER
http.createServer((req,res)=>{
  const html = fs.readFileSync("inferno-pool-test.html");
  res.writeHead(200,{"Content-Type":"text/html"});
  res.end(html);
}).listen(3000,()=>console.log("HTTP 3000 OK"));

// WS SERVER
const wss = new WebSocket.Server({ port: 3001 },()=>{
  console.log("WS 3001 OK");
});

let waiting = null;

function send(ws,data){
  try{ ws.send(JSON.stringify(data)); }catch(e){}
}

wss.on('connection',(ws)=>{
  console.log("WS CONNECTED");

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
});
