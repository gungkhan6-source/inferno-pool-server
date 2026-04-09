const http = require("http");
const WebSocket = require("ws");
const fs = require("fs");
const path = require("path");

// HTTP SERVER
const httpServer = http.createServer((req, res) => {
  let filePath = '.' + (req.url === '/' ? '/inferno-pool-test.html' : req.url);
  const ext = path.extname(filePath);

  const types = {
    '.html':'text/html',
    '.js':'application/javascript',
    '.css':'text/css',
    '.png':'image/png',
    '.jpg':'image/jpeg'
  };

  try {
    const data = fs.readFileSync(filePath);
    res.writeHead(200, {'Content-Type': types[ext] || 'text/html'});
    res.end(data);
  } catch(e) {
    res.writeHead(404);
    res.end('Not Found');
  }
});

// 🔥 WEBSOCKET (TEK)
const wss = new WebSocket.Server({ server: httpServer });

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

    if (waitingRoom && waitingRoom.host === ws) {
      waitingRoom = null;
      return;
    }

    const room = rooms.get(ws.roomId);
    if (room) {
      const other = ws.slot === 0 ? room.guest : room.host;
      send(other, {type:'opponent_left'});
      rooms.delete(ws.roomId);
    }
  });
});

// MATCH
function findMatch(ws, msg) {
  if (waitingRoom && waitingRoom.host !== ws) {
    const room = waitingRoom;

    room.guest = ws;
    ws.roomId = room.id;
    ws.slot = 1;

    rooms.set(room.id, room);
    waitingRoom = null;

    const seed = Math.floor(Math.random() * 999999);

    send(room.host, {type:'game_start', slot:0, ballSeed:seed});
    send(room.guest, {type:'game_start', slot:1, ballSeed:seed});

    console.log('MATCH', room.id);

  } else {
    const id = Math.random().toString(36).substr(2, 8);

    waitingRoom = { id, host: ws, guest: null };

    ws.roomId = id;
    ws.slot = 0;

    send(ws, {type:'waiting', roomId:id});

    console.log('WAIT', id);
  }
}

// RELAY
function relay(ws, msg) {
  const room = rooms.get(ws.roomId);
  if (!room) return;

  const other = ws.slot === 0 ? room.guest : room.host;
  if (other) send(other, msg);
}

// SEND
function send(ws, data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

// 🔥 PORT
const PORT = process.env.PORT || 3000;

httpServer.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});