const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

// HTTP SERVER — port 3000
const httpServer = http.createServer((req, res) => {
  let filePath = '.' + (req.url === '/' ? '/inferno-pool-test.html' : req.url);
  const ext = path.extname(filePath);
  const types = {'.html':'text/html','.js':'application/javascript','.css':'text/css','.png':'image/png','.jpg':'image/jpeg'};
  try {
    const data = fs.readFileSync(filePath);
    res.writeHead(200, {'Content-Type': types[ext]||'text/html'});
    res.end(data);
  } catch(e) {
    res.writeHead(404);
    res.end('Not Found');
  }
});
httpServer.listen(3000, () => console.log('HTTP: http://127.0.0.1:3000'));

// WS RELAY SERVER — port 3001
const wss = new WebSocket.Server({ port: 3001 }, () => console.log('WS: ws://127.0.0.1:3001'));
const rooms = new Map();
let waitingRoom = null;

wss.on('connection', (ws) => {
  ws.id = Math.random().toString(36).substr(2, 8);
  ws.roomId = null;
  ws.slot = null;
  console.log('+', ws.id);

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      switch(msg.type) {
        case 'find_match': findMatch(ws, msg); break;
        case 'relay':
        case 'rematch_request':
        case 'rematch_accept':
        case 'rematch_decline':
          relay(ws, msg); break;
        case 'ping': send(ws, {type:'pong'}); break;
      }
    } catch(e) {}
  });

  ws.on('close', () => {
    console.log('-', ws.id);
    if (waitingRoom && waitingRoom.host === ws) { waitingRoom = null; return; }
    const room = rooms.get(ws.roomId);
    if (room) {
      const other = ws.slot === 0 ? room.guest : room.host;
      send(other, {type:'opponent_left'});
      rooms.delete(ws.roomId);
    }
  });
});

function findMatch(ws, msg) {
  if (waitingRoom && waitingRoom.host !== ws) {
    const room = waitingRoom;
    room.guest = ws;
    ws.roomId = room.id;
    ws.slot = 1;
    rooms.set(room.id, room);
    waitingRoom = null;
    const seed = Math.floor(Math.random() * 999999);
    send(room.host, {type:'game_start', slot:0, ballSeed:seed, hostNick:room.nick, guestNick:msg.nickname||'Player'});
    send(room.guest, {type:'game_start', slot:1, ballSeed:seed, hostNick:room.nick, guestNick:msg.nickname||'Player'});
    console.log('MATCH', room.id);
  } else {
    const id = Math.random().toString(36).substr(2, 8);
    waitingRoom = {id, host:ws, guest:null, nick:msg.nickname||'Player'};
    ws.roomId = id;
    ws.slot = 0;
    send(ws, {type:'waiting', roomId:id});
    console.log('WAIT', id);
  }
}

function relay(ws, msg) {
  const room = rooms.get(ws.roomId);
  if (!room) return;
  const other = ws.slot === 0 ? room.guest : room.host;
  if (other) send(other, msg);
}

function send(ws, data) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}
