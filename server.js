const WebSocket = require('ws');
const http = require('http');

const server = http.createServer();
const wss = new WebSocket.Server({ server });

let waiting = null;
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

function createRoom(p1,p2){
  const room={
    players:[p1,p2],
    balls:makeBalls(),
    moving:false,
    firstShot:true,
    fxQueue:[]
  };
  p1.room=room;
  p2.room=room;
  rooms.add(room);
  return room;
}

function send(room,data){
  const msg=JSON.stringify(data);
  room.players.forEach(p=>{
    if(p.readyState===1)p.send(msg);
  });
}

function physStep(room){
  const balls=room.balls;

  balls.forEach(b=>{
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
  // single player fallback (no black screen)
  const fake = { readyState:1, send:()=>{} };

  const room=createRoom(ws,fake);
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
});

server.listen(3000,()=>{
  console.log("SERVER READY 3000");
});
