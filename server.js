const WebSocket = require('ws');
const http = require('http');

const server = http.createServer((req, res) => {
  res.writeHead(200, {'Content-Type': 'text/plain'});
  res.end('Inferno Pool Server OK');
});

const wss = new WebSocket.Server({ server });

// Odalar: {roomId: {host: ws, guest: ws, state: {}}}
const rooms = new Map();
// Bekleyen oda
let waitingRoom = null;

wss.on('connection', (ws) => {
  ws.id = Math.random().toString(36).substr(2,8);
  ws.roomId = null;
  ws.slot = null;

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      handleMessage(ws, msg);
    } catch(e) {}
  });

  ws.on('close', () => {
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
    case 'find_match':
      findMatch(ws, msg);
      break;
    case 'shot':
      relayShot(ws, msg);
      break;
    case 'sync':
      relaySync(ws, msg);
      break;
    case 'turn':
      relayTurn(ws, msg);
      break;
    case 'game_over':
      relayGameOver(ws, msg);
      break;
    case 'ping':
      send(ws, {type:'pong'});
      break;
  }
}

function findMatch(ws, msg) {
  if (waitingRoom && waitingRoom.host !== ws) {
    // Odaya katıl
    const room = waitingRoom;
    room.guest = ws;
    ws.roomId = room.id;
    ws.slot = 1;
    rooms.set(room.id, room);
    waitingRoom = null;

    // Her ikisine de oyun başla
    send(room.host, {type:'game_start', slot:0, ballSeed:room.ballSeed, 
      hostNick: msg.nickname, guestNick: msg.nickname});
    send(room.guest, {type:'game_start', slot:1, ballSeed:room.ballSeed,
      hostNick: room.hostNick, guestNick: msg.nickname});
  } else {
    // Yeni oda aç
    const roomId = Math.random().toString(36).substr(2,8);
    const ballSeed = Math.floor(Math.random() * 999999);
    const room = {id: roomId, host: ws, guest: null, ballSeed, hostNick: msg.nickname};
    ws.roomId = roomId;
    ws.slot = 0;
    waitingRoom = room;
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
  const data = {type:'sync', 
    ballPositions: ws.slot===0 ? msg.ballPositions : null,
    turn:msg.turn,
    scores:msg.scores,
    assigned:msg.assigned,
    sunk0:msg.sunk0, sunk1:msg.sunk1,
    inHand:msg.inHand
  };
  send(target, data);
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
  }
  const room = rooms.get(ws.roomId);
  if (room) {
    const target = ws.slot === 0 ? room.guest : room.host;
    send(target, {type:'opponent_left'});
    rooms.delete(ws.roomId);
  }
}

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Inferno Pool Server running on port ${PORT}`);
});
