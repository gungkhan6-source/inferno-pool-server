const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');

const server = http.createServer((req,res)=>{
  const html = fs.readFileSync("inferno-pool-test.html");
  res.writeHead(200,{"Content-Type":"text/html"});
  res.end(html);
});

const wss = new WebSocket.Server({ server });

wss.on('connection',(ws)=>{
  console.log("CLIENT CONNECTED");

  ws.send(JSON.stringify({type:"hello"}));

  ws.on('message',(msg)=>{
    console.log("MSG:", msg.toString());
    ws.send(JSON.stringify({type:"echo"}));
  });
});

server.listen(3000,()=>console.log("RUN http://127.0.0.1:3000"));
