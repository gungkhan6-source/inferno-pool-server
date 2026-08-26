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
    '.jpg':'image/jpeg',
    // 3D top katmani + ses varliklari icin ek MIME tipleri
    '.glb':'model/gltf-binary',
    '.gltf':'model/gltf+json',
    '.bin':'application/octet-stream',
    '.wav':'audio/wav',
    '.mp3':'audio/mpeg',
    '.svg':'image/svg+xml',
    '.json':'application/json'
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
        case 'turn_end': turnEnd(ws, msg); break;
        case 'forfeit_turn': forfeitTurn(ws); break;
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
  // D1 — Zaten AKTIF bir maçta olan socket yeniden kuyruga giremez.
  // Onceden: maçtaki oyuncu find_match gonderince bekleme odasina aliniyor,
  // ucuncu bir oyuncu gelince onunla esleşiyor ve ws.roomId/ws.slot uzerine
  // yaziliyordu -> ilk maç hicbir bildirim olmadan kopuyordu (maç hijacking).
  if (ws.roomId && rooms.has(ws.roomId)) return;
  // Zaten bekleme odasinin sahibiyse yeni oda acma; eskisi oksuz kalirdi.
  if (waitingRoom && waitingRoom.host === ws) return;

  // D6 — takma adi socket uzerinde sakla (game_start ile iletilecek).
  if (msg && typeof msg.nickname === 'string') {
    ws.nick = msg.nickname.slice(0, 24);
  }

  if (waitingRoom && waitingRoom.host !== ws) {
    const room = waitingRoom;

    room.guest = ws;
    ws.roomId = room.id;
    ws.slot = 1;

    rooms.set(room.id, room);
    waitingRoom = null;

    const seed = Math.floor(Math.random() * 999999);

    // D6 — istemci startOnlineGame(seed, hostNick, guestNick) bekliyor.
    const hostNick  = room.host.nick  || 'Player 1';
    const guestNick = room.guest.nick || 'Player 2';

    send(room.host,  {type:'game_start', slot:0, ballSeed:seed, hostNick:hostNick, guestNick:guestNick});
    send(room.guest, {type:'game_start', slot:1, ballSeed:seed, hostNick:hostNick, guestNick:guestNick});

    console.log('MATCH', room.id, hostNick, 'vs', guestNick);

  } else {
    const id = Math.random().toString(36).substr(2, 8);

    // D3/D4 — oda basina yetkilendirme state'i.
    // NOT: sunucu fizik CALISTIRMAZ; turn'u istemcilerin turn_end raporundan
    // ogrenir. Bu, "sirasi olmayan oyuncu atis yapamaz" ve "ball-in-hand
    // sahibi olmayan oyuncu beyaz topu yerlestiremez" garantilerini saglar.
    waitingRoom = { id, host: ws, guest: null, turn: 0, inHandFor: null, pending: false };

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

  // D2 — gonderen GERCEKTEN bu odanin oyuncusu mu?
  // Onceden yalnizca ws.roomId'ye bakiliyordu; bayat/yabanci bir socket
  // ayni roomId ile odaya mesaj enjekte edebiliyordu.
  if (ws !== room.host && ws !== room.guest) return;

  // Slot'u kimlikten turet (ws.slot uzerine yazilmis olabilir).
  const slot = (ws === room.host) ? 0 : 1;

  if (msg.sub === 'shot') {
    // D3 — atis yalnizca SIRADAKI oyuncudan, ve onceki atis cozulmusken.
    if (slot !== room.turn) return reject(ws, 'not_your_turn', room);
    if (room.pending)       return reject(ws, 'shot_in_progress', room);
    room.pending = true;

  } else if (msg.sub === 'place_cue') {
    // D4 — beyaz topu yalnizca ball-in-hand hakki olan SIRADAKI oyuncu koyar.
    if (slot !== room.turn)      return reject(ws, 'not_your_turn', room);
    if (room.inHandFor !== slot) return reject(ws, 'no_ball_in_hand', room);
    room.inHandFor = null;

  } else if (msg.sub === 'rematch_yes') {
    // Yeni maç: yetkilendirme state'ini sifirla.
    room.turn = 0; room.inHandFor = null; room.pending = false;
  }

  const other = slot === 0 ? room.guest : room.host;
  if (other) send(other, msg);
}

// Yetkisiz istek: relay ETME, state'i degistirme, baglantiyi KAPATMA.
function reject(ws, reason, room) {
  send(ws, {type:'shot_rejected', reason: reason, turn: room.turn,
            inHandFor: room.inHandFor});
  console.log('REJECT', reason, 'room', room.id);
}

// Tur sonucu bildirimi. Sunucu fizik calistirmadigi icin turn'u buradan ogrenir.
// Iki istemci de ayni deterministik fizigi calistirdigindan ilk gelen rapor
// kabul edilir, ikincisi yok sayilir (idempotent).
function turnEnd(ws, msg) {
  const room = rooms.get(ws.roomId);
  if (!room) return;
  if (ws !== room.host && ws !== room.guest) return;
  // D5-B" — LOCKSTEP: iki istemci de AYNI atis icin turn_end yollar.
  // Ilk rapor gecerlidir; ikinci rapor (pending=false) TAMAMEN YOK SAYILIR.
  // Forfeit ARTIK bu mesajla YAPILMAZ; ayri 'forfeit_turn' tipi kullanilir.
  if (!room.pending) return;

  // Normal atis sonrasi akis — DEGISMEDI.
  const t = (msg.turn === 0 || msg.turn === 1) ? msg.turn : room.turn;
  room.turn = t;
  room.inHandFor = (msg.inHand === true) ? t : null;
  room.pending = false;
}

// D5-B" — SHOT CLOCK FORFEIT. 'turn_end' den KESIN olarak ayrilmistir.
// DIKKAT: bu fonksiyon istemci mesajinin GOVDESINI HIC OKUMAZ (msg parametresi
// dahi yoktur) -> msg.turn / msg.inHand ile kendine ekstra tur veya
// ball-in-hand yazdirmak yapisal olarak IMKANSIZ.
function forfeitTurn(ws) {
  const room = rooms.get(ws.roomId);
  if (!room) return;
  if (ws !== room.host && ws !== room.guest) return;   // D2 uyelik kontrolu
  const slot = (ws === room.host) ? 0 : 1;
  if (room.pending) return;           // cozulmemis atis varken forfeit YOK
  if (slot !== room.turn) return;     // rakibin sirasi CALINAMAZ
  room.turn = (slot === 0) ? 1 : 0;   // tur yalnizca RAKIBE gecer
  room.inHandFor = null;              // forfeit ile ball-in-hand VERILMEZ
  console.log('FORFEIT room', room.id, 'slot', slot, '-> turn', room.turn);
  // Rakip sira degisikligini OGRENMELI; aksi halde iki istemci de
  // "sira bende degil" gorup maç kilitlenir.
  send(room.host,  { type:'turn_forfeited', turn: room.turn });
  send(room.guest, { type:'turn_forfeited', turn: room.turn });
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