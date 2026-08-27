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

// ═══════════════════════════════════════════════════════════════════
// HEARTBEAT — yarim-acik (half-open) baglanti tespiti
//
// SORUN: Mobil veri kapandiginda telefon TCP FIN/RST GONDERMEZ. Soket
// sunucuda OPEN gorunmeye devam eder, ws.on('close') HIC tetiklenmez,
// rakip 'opponent_left' alamaz ve ekrani donar. Isletim sisteminin TCP
// keepalive'i devreye girene kadar (Linux varsayilani ~2 SAAT) sunucu
// baglantiyi canli sanir.
//
// COZUM: Sunucu AKTIF olarak protokol seviyesi ping yollar; tarayicilar
// buna OTOMATIK pong doner (istemci kodu degisikligi GEREKMEZ). Iki tur
// ust uste pong gelmezse soket olu kabul edilip terminate edilir.
// terminate() mevcut ws.on('close') akisini tetikler -> 'opponent_left'
// DEGISMEDEN calisir.
//
// SURE SECIMI (HEARTBEAT_INTERVAL = 15000):
//   * Tespit penceresi 15-30 sn arasindadir (bir turda ping atilir,
//     bir sonraki turda cevap yoksa oldurulur).
//   * 15 sn, mobil agdaki KISA dalgalanmalari (baz istasyonu gecisi,
//     wifi<->hucresel handoff, tunel/asansor) elemek icin yeterince
//     uzundur: bu kesintiler tipik olarak 1-5 sn surer ve TCP yeniden
//     iletimi ile kendiliginden toparlanir, pong bir sonraki tura yetisir.
//   * 30 sn ust siniri, oyunun 30 saniyelik shot clock'u ile ayni
//     mertebededir; ekran "sonsuza kadar" donmaz.
//   * Daha kisa bir sure (orn. 5 sn) saglam baglantilarda YANLIS
//     kopma uretirdi; daha uzun bir sure (orn. 60 sn) donma hissini
//     kabul edilemez kilardi.
//
// TIMER YONETIMI: Soket BASINA timer YOKTUR. Tum soketleri tarayan
// TEK bir interval vardir. Bu sayede "ayni socket icin birden fazla
// timer" ve "close sonrasi temizlenmeyen timer" sinifi hatalar
// YAPISAL olarak imkansizdir; temizlenecek per-socket kaynak yoktur.
// Interval yalnizca sunucu kapanirken temizlenir (asagida).
// ═══════════════════════════════════════════════════════════════════
// ── UYGULAMA SEVIYESI HEARTBEAT (Render/Cloudflare icin ASIL yol) ──────
// OLCULEN GERCEK: Render'in WebSocket proxy'si baglantiyi UCTAN UCA
// tunellemiyor; iki ayri baglanti kuruyor:
//     Telefon --WS#1-- [proxy] --WS#2-- Node
// ws.ping() yalnizca WS#2 uzerinde gidiyor. Proxy kontrol frame'lerini
// KENDISI sonlandiriyor: ping'i telefona iletmiyor (olcum: 50 sn'de 0
// frame ulasti) ve sunucuya kendi adina pong donuyor. Sonuc: telefonun
// verisi kesilse bile isAlive hep true kaliyor, terminate hic calismiyor.
// Ayni kod yerelde (proxy'siz) kopmayi 19 sn'de yakaliyor.
//
// COZUM: Canliligi UYGULAMA mesajindan olc. Uygulama mesajlari proxy'yi
// sorunsuz geciyor (find_match / game_start / relay hepsi calisiyor).
// Istemci 10 saniyede bir {type:'ping'} yolluyor; 30 sn boyunca HICBIR
// mesaj gelmezse (3 ping kacirildi) baglanti olu kabul edilir.
//
// NOT: protokol seviyesi ws.ping() KALDIRILMADI. Proxy'siz ortamlarda
// (yerel, dogrudan baglanti, ileride farkli bir barindirma) daha hizli
// tespit sagladigi icin yan yana calisiyorlar. Hangisi once yakalarsa
// ayni terminate() -> close() -> opponent_left zincirini tetikler.
const HEARTBEAT_INTERVAL = 5000;    // tarama periyodu
const PROTO_PING_EVERY   = 3;       // 3 turda bir = 15 sn (onceki davranis korundu)
const APP_PING_TIMEOUT   = 30000;   // uygulama mesajsizlik esigi

function markAlive() {
  // 'this' = ilgili WebSocket. Protokol pong'u geldi.
  this.isAlive = true;
}

let hbTick = 0;
const heartbeatTimer = setInterval(() => {
  hbTick++;
  const simdi = Date.now();
  const protoTuru = (hbTick % PROTO_PING_EVERY) === 0;

  wss.clients.forEach((ws) => {
    // 1) UYGULAMA SEVIYESI — proxy'yi gecer, Render'da ASIL calisan yol.
    if (ws.lastAppMsg && (simdi - ws.lastAppMsg) > APP_PING_TIMEOUT) {
      console.log('DEAD', ws.id, '(app timeout ' +
                  Math.round((simdi - ws.lastAppMsg) / 1000) + 's)');
      return ws.terminate();
    }

    // 2) PROTOKOL SEVIYESI — proxy'siz ortamlarda daha hizli tespit.
    if (protoTuru) {
      if (ws.isAlive === false) {
        console.log('DEAD', ws.id, '(protocol pong timeout)');
        return ws.terminate();
      }
      ws.isAlive = false;
      try { ws.ping(); } catch(e) {}
    }
  });
}, HEARTBEAT_INTERVAL);

// Sunucu kapanirsa interval sizmasin (Render restart / SIGTERM).
wss.on('close', () => { clearInterval(heartbeatTimer); });

wss.on('connection', (ws) => {
  ws.id = Math.random().toString(36).substr(2, 8);
  ws.roomId = null;
  ws.slot = null;

  // HEARTBEAT: yeni soket canli kabul edilir; pong geldikce yenilenir.
  ws.isAlive = true;
  ws.on('pong', markAlive);
  // UYGULAMA HEARTBEAT: son uygulama mesaji zamani.
  ws.lastAppMsg = Date.now();

  console.log('+', ws.id);

  ws.on('message', (raw) => {
    // HEARTBEAT: mesaj gelmesi de canlilik kanitidir (pong'a ek guvence).
    ws.isAlive = true;
    // UYGULAMA HEARTBEAT: HERHANGI bir mesaj canliligi kanitlar; yalnizca
    // 'ping' degil. Aktif oyunda relay/turn_end de sayaci tazeler.
    ws.lastAppMsg = Date.now();
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
        // UYGULAMA HEARTBEAT: istemcinin 10 sn'lik ping'i canlilik kaynagi.
        case 'ping': ws.lastAppMsg = Date.now(); send(ws, {type:'pong'}); break;
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
