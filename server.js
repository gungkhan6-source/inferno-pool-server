const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');

const server = http.createServer((req,res)=>{
  const html = fs.readFileSync("inferno-pool-test.html");
  res.writeHead(200,{"Content-Type":"text/html"});
  res.end(html);
});

const wss = new WebSocket.Server({ server });

wss.on('connection',(ws,req)=>{
  console.log("CONNECTED FROM:", req.socket.remoteAddress);

  ws.send(JSON.stringify({type:"connected"}));

  ws.on('error',(e)=>console.log("WS ERROR:",e.message));
  ws.on('close',()=>console.log("WS CLOSED"));
});

server.listen(3000,'0.0.0.0',()=>console.log("RUN http://127.0.0.1:3000"));
