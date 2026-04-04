// ======================================
// 🔥 FULL WORKING SERVER (server.js)
// ======================================

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
  const balls = [];

  balls.push({id:0,x:200,y:200,vx:0,vy:0,sunk:false});

  let id=1;
  for(let row=0;row<5;row++){
    for(let col=0;col<=row;col++){
      balls.push({
        id:id++,
        x:450 + row*22,
        y:200 - row*11 + col*22,
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
    firstShot:true
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

  for(let i=0;i<balls.length;i++){
    for(let j=i+1;j<balls.length;j++){
      const a=balls[i], b=balls[j];
      if(a.sunk||b.sunk) continue;

      const dx=b.x-a.x;
      const dy=b.y-a.y;
      const dist=Math.sqrt(dx*dx+dy*dy);

      if(dist<R*2 && dist>0){
        const nx=dx/dist;
        const ny=dy/dist;

        const p=(a.vx*nx+a.vy*ny - b.vx*nx - b.vy*ny);

        a.vx-=p*nx;
        a.vy-=p*ny;
        b.vx+=p*nx;
        b.vy+=p*ny;
      }
    }
  }
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

  if(waiting){
    const room=createRoom(waiting,ws);

    send(room,{type:"init",balls:room.balls});

    waiting=null;
  }else{
    waiting=ws;
  }

  ws.on('message',(msg)=>{
    const data=JSON.parse(msg);
    const room=ws.room;
    if(!room) return;

    if(data.type==="shoot"){
      const cue=room.balls[0];

      let boost=1.5;
      if(room.firstShot){boost=2.2;room.firstShot=false;}

      cue.vx=data.vx*boost;
      cue.vy=data.vy*boost;

      room.moving=true;
    }
  });
});

server.listen(3000,()=>{
  console.log("SERVER READY 3000");
});


// ======================================
// 🔥 CLIENT ADD (HTML içine EKLE)
// ======================================

/*
ws.onmessage = (msg)=>{
  const data = JSON.parse(msg.data);

  if(data.type === "init"){
    balls = data.balls;
    render();
  }

  if(data.type === "sync"){
    balls = data.balls;
    render();
  }
};
*/

// render başına ekle:
// if(!balls || balls.length===0) return;
