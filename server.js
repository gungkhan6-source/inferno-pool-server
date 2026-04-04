const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

// --- HTTP SERVER (serves HTML on :3000) ---
const httpServer = http.createServer((req, res) => {
  const filePath = path.join(__dirname, 'inferno-pool-test.html');
  try {
    const html = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
  } catch (e) {
    res.writeHead(500);
    res.end('Failed to load HTML');
  }
});

httpServer.listen(3000, () => {
  console.log('HTTP: http://localhost:3000');
});

// --- WEBSOCKET SERVER (separate port :3001) ---
const wss = new WebSocket.Server({ port: 3001 }, () => {
  console.log('WS: ws://localhost:3001');
});

const rooms = new Set();

function makeBalls(){
  const balls = [];
  balls.push({ id:0, x:200, y:200, vx:0, vy:0, sunk:false });
  let id = 1;
  for(let r=0;r<5;r++){
    for(let c=0;c<=r;c++){
      balls.push({
        id:id++,
        x:450 + r*22,
        y:200 - r*11 + c*22,
        vx:0, vy:0, sunk:false
      });
    }
  }
  return balls;
}

function createRoom(ws){
  const room = {
    ws,
    balls: makeBalls(),
    moving: false
  };
  ws.room = room;
  rooms.add(room);
  return room;
}

function send(ws, data){
  try {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify(data));
    }
  } catch (e) {
    // ignore
  }
}

function physStep(room){
  const balls = room.balls;
  balls.forEach(b => {
    if (b.sunk) return;
    b.x += b.vx;
    b.y += b.vy;
    b.vx *= 0.985;
    b.vy *= 0.985;
    if (Math.abs(b.vx) < 0.05) b.vx = 0;
    if (Math.abs(b.vy) < 0.05) b.vy = 0;
  });
}

function loop(){
  rooms.forEach(room => {
    if (!room.moving) return;
    physStep(room);
    send(room.ws, { type: 'sync', balls: room.balls });
    const moving = room.balls.some(b => Math.abs(b.vx) > 0.05 || Math.abs(b.vy) > 0.05);
    if (!moving) room.moving = false;
  });
}

setInterval(loop, 16);

wss.on('connection', (ws) => {
  console.log('WS CONNECTED');
  const room = createRoom(ws);
  send(ws, { type: 'init', balls: room.balls });

  ws.on('message', (msg) => {
    try {
      const data = JSON.parse(msg);
      if (data.type === 'shoot') {
        const cue = room.balls[0];
        cue.vx = data.vx * 2;
        cue.vy = data.vy * 2;
        room.moving = true;
      }
    } catch (e) {}
  });

  ws.on('close', () => console.log('WS CLOSED'));
  ws.on('error', () => {});
});
