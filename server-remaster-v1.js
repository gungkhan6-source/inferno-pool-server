
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 3000);
const CLIENT_FILE = process.env.CLIENT_FILE || 'inferno-pool-remaster-v1.html';
const ROOT = __dirname;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.fnt': 'text/plain; charset=utf-8'
};

function safePath(urlPath) {
  const cleaned = decodeURIComponent(urlPath.split('?')[0]);
  const rel = cleaned === '/' ? `/${CLIENT_FILE}` : cleaned;
  const full = path.join(ROOT, rel);
  if (!full.startsWith(ROOT)) return null;
  return full;
}

const httpServer = http.createServer((req, res) => {
  const filePath = safePath(req.url || '/');
  if (!filePath) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bad Request');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600'
    });
    res.end(data);
  });
});

const wss = new WebSocket.Server({ server: httpServer });
const rooms = new Map();
let waitingPlayer = null;

function send(ws, payload) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function otherPlayer(room, ws) {
  if (!room) return null;
  return room.host === ws ? room.guest : room.host;
}

function clearWaitingIf(ws) {
  if (waitingPlayer && waitingPlayer.ws === ws) {
    waitingPlayer = null;
  }
}

function closeRoom(roomId, reason = 'opponent_left', leaver = null) {
  const room = rooms.get(roomId);
  if (!room) return;
  const other = leaver ? otherPlayer(room, leaver) : null;
  if (other) send(other, { type: reason });
  rooms.delete(roomId);
}

function createRoomId() {
  return Math.random().toString(36).slice(2, 10);
}

function startMatch(hostEntry, guestWs, guestNick) {
  const roomId = hostEntry.id;
  const room = {
    id: roomId,
    createdAt: Date.now(),
    host: hostEntry.ws,
    hostNick: hostEntry.nickname || 'Player 1',
    guest: guestWs,
    guestNick: guestNick || 'Player 2'
  };

  hostEntry.ws.roomId = roomId;
  hostEntry.ws.slot = 0;
  guestWs.roomId = roomId;
  guestWs.slot = 1;

  rooms.set(roomId, room);
  waitingPlayer = null;

  const seed = Math.floor(Math.random() * 999999);
  send(room.host, { type: 'game_start', slot: 0, ballSeed: seed, hostNick: room.hostNick, guestNick: room.guestNick });
  send(room.guest, { type: 'game_start', slot: 1, ballSeed: seed, hostNick: room.hostNick, guestNick: room.guestNick });
  console.log('MATCH', roomId, room.hostNick, 'vs', room.guestNick);
}

function handleFindMatch(ws, msg) {
  clearWaitingIf(ws);
  if (waitingPlayer && waitingPlayer.ws !== ws && waitingPlayer.ws.readyState === WebSocket.OPEN) {
    startMatch(waitingPlayer, ws, msg.nickname);
    return;
  }

  waitingPlayer = {
    id: createRoomId(),
    ws,
    nickname: msg.nickname || 'Player 1',
    createdAt: Date.now()
  };
  ws.roomId = waitingPlayer.id;
  ws.slot = 0;
  send(ws, { type: 'waiting', roomId: waitingPlayer.id });
  console.log('WAIT', waitingPlayer.id, waitingPlayer.nickname);
}

function relay(ws, msg) {
  const room = rooms.get(ws.roomId);
  if (!room) return;
  const other = otherPlayer(room, ws);
  if (other) send(other, msg);
}

function heartbeatSweep() {
  const now = Date.now();
  if (waitingPlayer && now - waitingPlayer.createdAt > 120000) {
    send(waitingPlayer.ws, { type: 'waiting_timeout' });
    waitingPlayer = null;
  }

  for (const [roomId, room] of rooms) {
    const hostDead = !room.host || room.host.readyState !== WebSocket.OPEN;
    const guestDead = !room.guest || room.guest.readyState !== WebSocket.OPEN;
    if (hostDead || guestDead) {
      const survivor = hostDead ? room.guest : room.host;
      send(survivor, { type: 'opponent_left' });
      rooms.delete(roomId);
    }
  }
}

setInterval(heartbeatSweep, 10000);

wss.on('connection', (ws) => {
  ws.id = Math.random().toString(36).slice(2, 10);
  ws.roomId = null;
  ws.slot = null;
  console.log('+', ws.id);

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    switch (msg.type) {
      case 'find_match':
        handleFindMatch(ws, msg);
        break;
      case 'relay':
      case 'rematch_request':
      case 'rematch_accept':
      case 'rematch_decline':
        relay(ws, msg);
        break;
      case 'ping':
        send(ws, { type: 'pong' });
        break;
      default:
        break;
    }
  });

  ws.on('close', () => {
    console.log('-', ws.id);
    clearWaitingIf(ws);
    if (ws.roomId) closeRoom(ws.roomId, 'opponent_left', ws);
  });
});

httpServer.listen(PORT, () => {
  console.log(`Inferno Pool Remaster server running on port ${PORT}`);
  console.log(`Serving: ${CLIENT_FILE}`);
});
