const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const server = http.createServer((req,res)=>{
  const file = fs.readFileSync(path.join(__dirname,"inferno-pool-test.html"));
  res.writeHead(200,{"Content-Type":"text/html"});
  res.end(file);
});

const wss = new WebSocket.Server({ server });

const rooms = new Set();

const R = 10;
const FRICTION = 0.985;
const MIN_V = 0.05;

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

function createRoom(ws){
  const fake = { readyState:1, send:()=>{} };

  const room={
    players:[ws,fake],
    balls:makeBalls(),
    moving:false
  };

  ws.room=room;
  rooms.add(room);

  return room;
}

function send(room,data){
  const msg=JSON.stringify(data);

  room.players.forEach(p=>{
    try{
      if(p.readyState===1){
        p.send(msg);
      }
    }catch(e){}
  });
}

function physStep(room){
  room.balls.forEach(b=>{
    if(b.sunk) return;

    b.x+=b.vx;
    b.y+=b.vy;

    b.vx*=FRICTION;
    b.vy*=FRICTION;

    if(Math.abs(b.vx)<MIN_V) b.vx=0;
    if(Math.abs(b.vy)<MIN_V) b.vy=0;
  });
}

function loop(){
  rooms.forEach(room=>{
    if(!room.moving) return;

    physStep(room);

    send(room,{type:"sync",balls:room.balls});

    const moving=room.balls.some(b=>Math.abs(b.vx)>MIN_V||Math.abs(b.vy)>MIN_V);
    if(!moving) room.moving=false;
  });
}

setInterval(loop,16);

wss.on('connection',(ws)=>{
  console.log("CLIENT CONNECTED");

  const room=createRoom(ws);
  send(room,{type:"init",balls:room.balls});

  ws.on('message',(msg)=>{
    const data=JSON.parse(msg);

    if(data.type==="shoot"){
      const cue=room.balls[0];
      cue.vx=data.vx*2;
      cue.vy=data.vy*2;
      room.moving=true;
    }
  });

  ws.on('close', ()=>{});
  ws.on('error', ()=>{});
});

server.listen(3000,()=>{
  console.log("SERVER READY http://localhost:3000");
});
