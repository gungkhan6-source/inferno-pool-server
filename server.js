const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const server = http.createServer((req,res)=>{
  const file = fs.readFileSync(path.join(__dirname,"inferno-pool-test.html"));
  res.writeHead(200,{"Content-Type":"text/html"});
  res.end(file);
});

server.listen(3000,()=>console.log("HTTP OK"));

const wss = new WebSocket.Server({ server });

let waitingPlayer = null;

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

function send(ws,data){
  try{ ws.send(JSON.stringify(data)); }catch(e){}
}

wss.on('connection',(ws)=>{
  if(waitingPlayer){
    const p1=waitingPlayer;
    const p2=ws;

    const room={
      players:[p1,p2],
      balls:makeBalls(),
      moving:false
    };

    p1.room=room;
    p2.room=room;

    send(p1,{type:"match"});
    send(p2,{type:"match"});

    send(p1,{type:"init",balls:room.balls});
    send(p2,{type:"init",balls:room.balls});

    waitingPlayer=null;
  }else{
    waitingPlayer=ws;
    send(ws,{type:"waiting"});
  }

  ws.on('message',(msg)=>{
    const data=JSON.parse(msg);
    const room=ws.room;
    if(!room) return;

    if(data.type==="shoot"){
      const cue=room.balls[0];
      cue.vx=data.vx*2;
      cue.vy=data.vy*2;
      room.moving=true;
    }
  });
});

setInterval(()=>{
  wss.clients.forEach(ws=>{
    const room=ws.room;
    if(!room||!room.moving) return;

    room.balls.forEach(b=>{
      b.x+=b.vx;
      b.y+=b.vy;
      b.vx*=0.98;
      b.vy*=0.98;
    });

    room.players.forEach(p=>{
      send(p,{type:"sync",balls:room.balls});
    });

    const moving=room.balls.some(b=>Math.abs(b.vx)>0.05||Math.abs(b.vy)>0.05);
    if(!moving) room.moving=false;
  });
},16);
