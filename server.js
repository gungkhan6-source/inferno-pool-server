const WebSocket = require('ws');
const http = require('http');

const server = http.createServer((req, res) => {
  res.writeHead(200, {'Content-Type': 'text/plain'});
  res.end('Inferno Pool Server OK');
});

const wss = new WebSocket.Server({ server });

const rooms = new Map();
let waitingRoom = null;

wss.on('connection', (ws) => {
  ws.id = Math.random().toString(36).substr(2,8);
  ws.roomId = null;
  ws.slot = null;
  console.log('New connection:', ws.id, 'Total:', wss.clients.size);

  ws.on('message', (raw) => {
    try { 
      const msg = JSON.parse(raw);
      console.log('Message from', ws.id, ':', msg.type);
      handleMessage(ws, msg); 
    } catch(e) { console.error('Parse error:', e); }
  });

  ws.on('close', () => { 
    console.log('Disconnected:', ws.id);
    handleDisconnect(ws); 
  });
});

function send(ws, data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function handleMessage(ws, msg) {
  switch(msg.type) {
    case 'find_match': findMatch(ws, msg); break;
    case 'shot': relayShot(ws, msg); break;
    case 'sync': relaySync(ws, msg); break;
    case 'turn': relayTurn(ws, msg); break;
    case 'game_over': relayGameOver(ws, msg); break;
    case 'ping': send(ws, {type:'pong'}); break;
  }
}

function findMatch(ws, msg) {
  console.log('findMatch:', ws.id, 'waitingRoom:', waitingRoom ? waitingRoom.id : 'none');
  
  if (waitingRoom && waitingRoom.host !== ws) {
    const room = waitingRoom;
    room.guest = ws;
    ws.roomId = room.id;
    ws.slot = 1;
    rooms.set(room.id, room);
    waitingRoom = null;
    console.log('Match found! Room:', room.id);
    send(room.host, {type:'game_start', slot:0, ballSeed:room.ballSeed, hostNick:room.hostNick, guestNick:msg.nickname});
    send(room.guest, {type:'game_start', slot:1, ballSeed:room.ballSeed, hostNick:room.hostNick, guestNick:msg.nickname});
  } else {
    const roomId = Math.random().toString(36).substr(2,8);
    const ballSeed = Math.floor(Math.random() * 999999);
    const room = {id:roomId, host:ws, guest:null, ballSeed, hostNick:msg.nickname};
    ws.roomId = roomId;
    ws.slot = 0;
    waitingRoom = room;
    console.log('Waiting room created:', roomId);
    send(ws, {type:'waiting', roomId});
  }
}

function relayShot(ws, msg) {
  const room = rooms.get(ws.roomId);
  if (!room) return;
  const target = ws.slot === 0 ? room.guest : room.host;
  send(target, {type:'shot', vx:msg.vx, vy:msg.vy, shooter:ws.slot, ts:msg.ts});
}

function relaySync(ws, msg) {
  const room = rooms.get(ws.roomId);
  if (!room) return;
  const target = ws.slot === 0 ? room.guest : room.host;
  send(target, {type:'sync',
    ballPositions: ws.slot===0 ? msg.ballPositions : null,
    turn:msg.turn, scores:msg.scores, assigned:msg.assigned,
    sunk0:msg.sunk0, sunk1:msg.sunk1, inHand:msg.inHand
  });
}

function relayTurn(ws, msg) {
  const room = rooms.get(ws.roomId);
  if (!room) return;
  const target = ws.slot === 0 ? room.guest : room.host;
  send(target, {type:'turn', turn:msg.turn});
}

function relayGameOver(ws, msg) {
  const room = rooms.get(ws.roomId);
  if (!room) return;
  const target = ws.slot === 0 ? room.guest : room.host;
  send(target, {type:'game_over', winner:msg.winner, reason:msg.reason});
}

function handleDisconnect(ws) {
  if (waitingRoom && waitingRoom.host === ws) {
    waitingRoom = null;
    console.log('Waiting room cleared');
  }
  const room = rooms.get(ws.roomId);
  if (room) {
    const target = ws.slot === 0 ? room.guest : room.host;
    send(target, {type:'opponent_left'});
    rooms.delete(ws.roomId);
    console.log('Room deleted:', ws.roomId);
  }
}

const PORT = process.env.PORT || 3001;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Inferno Pool Server running on port ${PORT}`);
});
