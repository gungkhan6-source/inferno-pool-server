const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

// HTTP SERVER
const server = http.createServer((req,res)=>{
  let filePath = "inferno-pool-test.html";

  if(req.url === "/" || req.url === "/inferno-pool-test.html"){
    filePath = "inferno-pool-test.html";
  }

  try{
    const file = fs.readFileSync(path.join(__dirname,filePath));
    res.writeHead(200,{"Content-Type":"text/html"});
    res.end(file);
  }catch(e){
    res.writeHead(404);
    res.end("Not found");
  }
});

server.listen(3000,()=>{
  console.log("HTTP OK http://localhost:3000");
});

// WS SERVER (PORT 3001)
const wss = new WebSocket.Server({ port:3001 },()=>{
  console.log("WS OK ws://localhost:3001");
});

function makeBalls(){
  const balls=[];
  balls.push({id:0,x:200,y:200,vx:0,vy:0,sunk:false});

  let id=1;
  for(let r=0;r<5;r++){
    for(let c=0;c<=r;c++){
      balls.push({
        id:id++,
        x:450+r*22,
        y:200-r*11+c*22,
        vx:0,vy:0,sunk:false
      });
    }
  }
  return balls;
}

wss.on('connection',(ws)=>{
  console.log("WS CONNECTED");

  const room={
    balls:makeBalls(),
    moving:false
  };

  ws.send(JSON.stringify({type:"init",balls:room.balls}));

  ws.on('message',(msg)=>{
    const data=JSON.parse(msg);

    if(data.type==="shoot"){
      const cue=room.balls[0];
      cue.vx=data.vx*2;
      cue.vy=data.vy*2;
      room.moving=true;
    }
  });

  setInterval(()=>{
    if(!room.moving) return;

    room.balls.forEach(b=>{
      b.x+=b.vx;
      b.y+=b.vy;
      b.vx*=0.98;
      b.vy*=0.98;
    });

    ws.send(JSON.stringify({type:"sync",balls:room.balls}));
  },16);

  ws.on('close',()=>console.log("WS CLOSED"));
  ws.on('error',()=>{});
});
