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

        if(Math.abs(p)>1){
          room.fxQueue.push({type:"hit",x:a.x,y:a.y});
        }
      }
    }
  }

  balls.forEach(b=>{
    if(b.sunk) return;

    if(
      (b.x<30&&b.y<30)||(b.x>710&&b.y<30)||
      (b.x<30&&b.y>370)||(b.x>710&&b.y>370)
    ){
      b.sunk=true;
      b.vx=0;b.vy=0;

      room.fxQueue.push({type:"pocket",x:b.x,y:b.y});
    }
  });
}

function loop(){
  rooms.forEach(room=>{
    if(!room.moving) return;

    physStep(room);

    send(room,{type:"sync",balls:room.balls});

    if(room.fxQueue.length){
      send(room,{type:"fx",effects:room.fxQueue});
      room.fxQueue=[];
    }

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
      if(room.firstShot){
        boost=2.2;
        room.firstShot=false;
      }

      cue.vx=data.vx*boost;
      cue.vy=data.vy*boost;

      room.moving=true;
    }
  });
});

server.listen(3000,()=>{
  console.log("SERVER READY 3000");
});
