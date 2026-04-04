const WebSocket = require('ws');
const http = require('http');

const server = http.createServer((req, res) => {
  res.writeHead(200, {'Content-Type': 'text/plain'});
  res.end('Inferno Pool Server OK');
});

const wss = new WebSocket.Server({ server });
const rooms = new Map();
let waitingRoom = null;

const CW=740, CH=400, PAD=32, R=10, FRICTION=0.9835, MIN_V=0.07, PR=19;
const POCKETS=[
  {x:PAD,y:PAD},{x:CW/2,y:PAD-6},{x:CW-PAD,y:PAD},
  {x:PAD,y:CH-PAD},{x:CW/2,y:CH-PAD+6},{x:CW-PAD,y:CH-PAD}
];

function makeBalls(seed) {
  // Mulberry32 PRNG — must match client exactly
  let s = seed;
  function rand() {
    s |= 0; s = s + 0x6D2B79F5 | 0;
    let t = Math.imul(s ^ s >>> 15, 1 | s);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  }
  // Element keys (same order as client)
  const elKeys = ['fire','ice','poison','shadow'];

  // Build solid + stripe type arrays (same as client makeBallsSeeded)
  const solidT=[], stripeT=[];
  for(let i=0;i<4;i++) solidT.push(elKeys[i%elKeys.length]);
  solidT.push(elKeys[0]); solidT.push(elKeys[1]); solidT.push(elKeys[2]);
  for(let i=0;i<4;i++) stripeT.push(elKeys[(i+1)%elKeys.length]);
  stripeT.push(elKeys[3]); stripeT.push(elKeys[0]); stripeT.push(elKeys[1]);

  // Seeded shuffle (same as client)
  for(let i=solidT.length-1;i>0;i--){const j=Math.floor(rand()*(i+1));[solidT[i],solidT[j]]=[solidT[j],solidT[i]];}
  for(let i=stripeT.length-1;i>0;i--){const j=Math.floor(rand()*(i+1));[stripeT[i],stripeT[j]]=[stripeT[j],stripeT[i]];}

  // Build rack: 7 solid (id 1-7), 8ball (id 8), 7 stripe (id 9-15)
  const rack2=[];
  for(let i=0;i<7;i++) rack2.push({type:solidT[i],stripe:false,id:i+1});
  rack2.push({type:'8ball',stripe:false,id:8});
  for(let i=0;i<7;i++) rack2.push({type:stripeT[i],stripe:true,id:i+9});

  // Shuffle non-eight, insert 8ball at position 4
  const nonE=rack2.filter(b=>b.type!=='8ball');
  for(let i=nonE.length-1;i>0;i--){const j=Math.floor(rand()*(i+1));[nonE[i],nonE[j]]=[nonE[j],nonE[i]];}
  nonE.splice(4,0,rack2.find(b=>b.type==='8ball'));

  // Position balls — same formula as client
  const balls=[];
  let ri2=0;
  const sx2=CW*0.625, sy2=CH/2;
  for(let row=0;row<5;row++){
    for(let col=0;col<=row;col++){
      const x=sx2+row*(R*2+1.2);
      const y=sy2-row*(R+0.6)+col*(R*2+1.2);
      const b=nonE[ri2++]; if(!b) continue;
      balls.push({id:b.id,x,y,vx:0,vy:0,sunk:false,stripe:b.stripe,type:b.type==='8ball'?'eight':'ball'});
    }
  }
  // Cue ball — position must match client's makeCue()
  balls.unshift({id:0,x:CW*0.26,y:CH/2,vx:0,vy:0,sunk:false,type:'cue'});
  return balls;
}

function physStep(balls) {
  const all = balls.filter(b=>b&&!b.sunk);
  const sunkIds=[];
  
  const STEPS=4;
  for(let step=0;step<STEPS;step++){
    // Move
    all.forEach(b=>{
      b.x+=b.vx/STEPS;
      b.y+=b.vy/STEPS;
    });
    
    // Pocket check first (prevents bounce back)
    all.forEach(b=>{
      if(b.sunk) return;
      for(const p of POCKETS){
        const dx=b.x-p.x, dy=b.y-p.y;
        if(Math.sqrt(dx*dx+dy*dy)<PR){
          b.sunk=true; b.vx=0; b.vy=0;
          sunkIds.push(b.id);
          break;
        }
      }
    });
    
    // Wall collision (skip sunk)
    all.forEach(b=>{
      if(b.sunk) return;
      if(b.x-R<PAD){b.x=PAD+R;b.vx=Math.abs(b.vx)*0.85;}
      if(b.x+R>CW-PAD){b.x=CW-PAD-R;b.vx=-Math.abs(b.vx)*0.85;}
      if(b.y-R<PAD){b.y=PAD+R;b.vy=Math.abs(b.vy)*0.85;}
      if(b.y+R>CH-PAD){b.y=CH-PAD-R;b.vy=-Math.abs(b.vy)*0.85;}
    });
    
    // Ball-ball collision (2 passes, skip sunk)
    const active = all.filter(b=>!b.sunk);
    for(let pass=0;pass<2;pass++){
      for(let i=0;i<active.length;i++){
        for(let j=i+1;j<active.length;j++){
          const a=active[i],b=active[j];
          const dx=b.x-a.x, dy=b.y-a.y;
          const dist=Math.sqrt(dx*dx+dy*dy);
          if(dist<R*2&&dist>0.001){
            const nx=dx/dist, ny=dy/dist;
            const overlap=(R*2-dist)/2;
            a.x-=nx*overlap; a.y-=ny*overlap;
            b.x+=nx*overlap; b.y+=ny*overlap;
            const dvx=a.vx-b.vx, dvy=a.vy-b.vy;
            const dot=dvx*nx+dvy*ny;
            if(dot>0){
              a.vx-=dot*nx; a.vy-=dot*ny;
              b.vx+=dot*nx; b.vy+=dot*ny;
            }
          }
        }
      }
    }
  }
  
  // Friction
  all.forEach(b=>{
    if(b.sunk) return;
    b.vx*=FRICTION; b.vy*=FRICTION;
    if(Math.abs(b.vx)<MIN_V) b.vx=0;
    if(Math.abs(b.vy)<MIN_V) b.vy=0;
  });
  
  return sunkIds;
}

function isMoving(balls) {
  return balls.some(b=>b&&!b.sunk&&(Math.abs(b.vx)>MIN_V||Math.abs(b.vy)>MIN_V));
}

function startPhysicsLoop(room) {
  if(room.physInterval) clearInterval(room.physInterval);
  room.physInterval = setInterval(()=>{
    if(!room.moving) return;
    const sunk = physStep(room.balls);
    sunk.forEach(id=>{
      if(!room.sunkBalls.includes(id)) room.sunkThisShot.push(id);
    });
    room.syncCounter=(room.syncCounter||0)+1;
    sendSync(room); // Send every frame for smooth animation
    if(!isMoving(room.balls)){
      room.moving=false;
      clearInterval(room.physInterval);
      room.physInterval=null;
      sendSync(room);
      handleTurnEnd(room);
    }
  }, 16);
}

function handleTurnEnd(room) {
  console.log('handleTurnEnd called, sunkThisShot=', room.sunkThisShot, 'cue.sunk=', room.balls.find(b=>b.id===0)?.sunk);
  const cue = room.balls.find(b=>b.id===0);
  if(cue && cue.sunk){
    cue.sunk=false; cue.x=CW*0.26; cue.y=CH/2; cue.vx=0; cue.vy=0;
    room.turn=room.turn===0?1:0;
    room.inHand=true;
    room.sunkThisShot=[];
    sendTurn(room);
    return;
  }
  if(room.sunkThisShot.length>0){
    console.log('sunkThisShot:', room.sunkThisShot);
    if(room.sunkThisShot.includes(8)){
      // First shot - rerack
      if(room.shotCount<=1){
        const newSeed=Math.floor(Math.random()*999999);
        room.balls=makeBalls(newSeed);
        room.sunkBalls=[]; room.sunk0=[]; room.sunk1=[];
        room.assigned=null; room.inHand=false; room.sunkThisShot=[];
        sendToRoom(room,{type:'rerack',ballSeed:newSeed});
        sendTurn(room);
        return;
      }
      // 8 ball - win if all your balls sunk, lose if not
      let winner = room.turn;
      if(room.assigned && room.assigned[room.turn]!==null){
        const myStripe = room.assigned[room.turn];
        const myLeft = room.balls.filter(b=>!b.sunk&&b.stripe===myStripe&&b.type!=='eight').length;
        if(myLeft > 0) winner = room.turn===0?1:0; // Potted too early, loses
      }
      if(room.physInterval) clearInterval(room.physInterval);
      console.log('Sending game_over, winner='+winner+' host='+!!room.host+' guest='+!!room.guest);
      const goMsg = {type:'game_over',winner,reason:winner===room.turn?'8 Ball Potted - Victory!':'8 Ball Too Early - Forfeit!'};
      send(room.host, goMsg);
      send(room.guest, goMsg);
      room.finished=true; // Keep room for rematch
      return;
    }
    const sunkBall=room.balls.find(b=>b.id===room.sunkThisShot[0]);
    if(sunkBall && room.assigned===null){
      room.assigned=[null,null];
      room.assigned[room.turn]=sunkBall.stripe;
      room.assigned[room.turn===0?1:0]=!sunkBall.stripe;
    }
    let ownBall=true;
    if(room.assigned && room.assigned[room.turn]!==null){
      const myStripe=room.assigned[room.turn];
      ownBall=room.sunkThisShot.every(id=>{
        const b=room.balls.find(x=>x.id===id);
        return b && b.stripe===myStripe;
      });
    }
    room.sunkThisShot.forEach(id=>{
      if(!room.sunkBalls.includes(id)){
        room.sunkBalls.push(id);
        if(ownBall){ if(room.turn===0) room.sunk0.push(id); else room.sunk1.push(id); }
        else { if(room.turn===0) room.sunk1.push(id); else room.sunk0.push(id); }
      }
    });
    if(!ownBall) room.turn=room.turn===0?1:0;
    room.inHand=false;
  } else {
    room.turn=room.turn===0?1:0;
    room.inHand=false;
  }
  room.sunkThisShot=[];
  sendTurn(room);
}

function sendSync(room) {
  const balls=room.balls.map(b=>({id:b.id,x:Math.round(b.x*10)/10,y:Math.round(b.y*10)/10,vx:Math.round(b.vx*100)/100,vy:Math.round(b.vy*100)/100,sunk:b.sunk,stripe:b.stripe,type:b.type}));
  sendToRoom(room,{type:'sync',balls,turn:room.turn,moving:room.moving,inHand:room.inHand,sunkBalls:room.sunkBalls,sunk0:room.sunk0,sunk1:room.sunk1});
}

function sendTurn(room) {
  const balls=room.balls.map(b=>({id:b.id,x:Math.round(b.x*10)/10,y:Math.round(b.y*10)/10,vx:0,vy:0,sunk:b.sunk,stripe:b.stripe,type:b.type}));
  sendToRoom(room,{type:'turn',turn:room.turn,inHand:room.inHand,sunkBalls:room.sunkBalls,sunk0:room.sunk0,sunk1:room.sunk1,balls,assigned:room.assigned});
}

function sendToRoom(room,data) {
  send(room.host,data);
  send(room.guest,data);
}

function send(ws,data) {
  if(ws&&ws.readyState===WebSocket.OPEN) ws.send(JSON.stringify(data));
}

wss.on('connection',(ws)=>{
  ws.id=Math.random().toString(36).substr(2,8);
  ws.roomId=null; ws.slot=null;
  console.log('New connection:',ws.id);
  ws.on('message',(raw)=>{ try{handleMessage(ws,JSON.parse(raw));}catch(e){} });
  ws.on('close',()=>handleDisconnect(ws));
});

function handleMessage(ws,msg) {
  if(msg.type!=='ping') console.log('MSG:',msg.type,'roomId:',ws.roomId,'rooms:',rooms.size);
  switch(msg.type){
    case 'find_match': findMatch(ws,msg); break;
    case 'shot': handleShot(ws,msg); break;
    case 'client_sync': handleClientSync(ws,msg); break;
    case 'host_turn': handleHostTurn(ws,msg); break;
    case 'rematch_request': handleRematch(ws,msg); break;
    case 'rematch_accept': handleRematchAccept(ws,msg); break;
    case 'rematch_decline': handleRematchDecline(ws,msg); break;
    case 'ping': send(ws,{type:'pong'}); break;
  }
}

function handleHostTurn(ws,msg) {
  const room=rooms.get(ws.roomId);
  if(!room||ws.slot!==0) return;
  send(room.guest,{type:'host_turn',turn:msg.turn,inHand:msg.inHand,
    assigned:msg.assigned,sunk0:msg.sunk0,sunk1:msg.sunk1});
}

function handleClientSync(ws,msg) {
  const room=rooms.get(ws.roomId);
  if(!room||ws.slot!==0) return; // Only host can send client_sync
  const target=room.guest;
  send(target,{type:'client_sync', balls:msg.balls, moving:msg.moving,
    turn:msg.turn, inHand:msg.inHand, assigned:msg.assigned,
    sunk0:msg.sunk0, sunk1:msg.sunk1});
}

function handleRematch(ws,msg) {
  console.log('handleRematch called, roomId='+ws.roomId+' rooms='+rooms.size);
  const room=rooms.get(ws.roomId);
  if(!room){ console.log('Room not found!'); return; }
  console.log('Sending rematch_request to other player');
  const target=ws.slot===0?room.guest:room.host;
  send(target,{type:'rematch_request'});
}

function handleRematchAccept(ws,msg) {
  const room=rooms.get(ws.roomId);
  if(!room) return;
  // New game - same players, new ball setup
  const newSeed=Math.floor(Math.random()*999999);
  room.balls=makeBalls(newSeed);
  room.turn=0; room.moving=false; room.inHand=false;
  room.sunkBalls=[]; room.sunkThisShot=[]; room.sunk0=[]; room.sunk1=[];
  room.assigned=null; room.shooter=0; room.syncCounter=0; room.shotCount=0;
  if(room.physInterval){clearInterval(room.physInterval);room.physInterval=null;}
  // Send game_start to both players
  send(room.host,{type:'game_start',slot:0,ballSeed:newSeed,hostNick:'Player 1',guestNick:'Player 2'});
  send(room.guest,{type:'game_start',slot:1,ballSeed:newSeed,hostNick:'Player 1',guestNick:'Player 2'});
}

function handleRematchDecline(ws,msg) {
  const room=rooms.get(ws.roomId);
  if(!room) return;
  const target=ws.slot===0?room.guest:room.host;
  send(target,{type:'rematch_declined'});
}

function findMatch(ws,msg) {
  if(waitingRoom&&waitingRoom.host!==ws){
    const room=waitingRoom;
    room.guest=ws; ws.roomId=room.id; ws.slot=1;
    rooms.set(room.id,room); waitingRoom=null;
    console.log('Match found! Room:',room.id);
    send(room.host,{type:'game_start',slot:0,ballSeed:room.ballSeed,hostNick:room.hostNick,guestNick:msg.nickname});
    send(room.guest,{type:'game_start',slot:1,ballSeed:room.ballSeed,hostNick:room.hostNick,guestNick:msg.nickname});
  } else {
    const roomId=Math.random().toString(36).substr(2,8);
    const ballSeed=Math.floor(Math.random()*999999);
    const room={id:roomId,host:ws,guest:null,ballSeed,hostNick:msg.nickname,
      balls:makeBalls(ballSeed),turn:0,moving:false,inHand:false,
      sunkBalls:[],sunkThisShot:[],sunk0:[],sunk1:[],shooter:0,
      assigned:null,physInterval:null,syncCounter:0,
      shotCount:0,ballSeed};
    ws.roomId=roomId; ws.slot=0; waitingRoom=room;
    console.log('Waiting room:',roomId);
    send(ws,{type:'waiting',roomId});
  }
}

function handleShot(ws,msg) {
  const room=rooms.get(ws.roomId);
  if(!room||room.moving) return;
  if(ws.slot!==room.turn) return;
  const cue=room.balls.find(b=>b.id===0);
  if(!cue||cue.sunk) return;
  cue.vx=msg.vx; cue.vy=msg.vy;
  room.moving=true; room.sunkThisShot=[]; room.shooter=ws.slot;
  room.shotCount++;
  sendToRoom(room,{type:'shot_ack',shooter:ws.slot,vx:msg.vx,vy:msg.vy});
  startPhysicsLoop(room);
}

function handleDisconnect(ws) {
  if(waitingRoom&&waitingRoom.host===ws) waitingRoom=null;
  const room=rooms.get(ws.roomId);
  if(room){
    if(room.physInterval) clearInterval(room.physInterval);
    const target=ws.slot===0?room.guest:room.host;
    send(target,{type:'opponent_left'});
    rooms.delete(ws.roomId);
    console.log('Room deleted:',ws.roomId);
  }
}

const PORT=process.env.PORT||3001;
server.listen(PORT,'0.0.0.0',()=>{
  console.log('Inferno Pool Server running on port '+PORT);
});
