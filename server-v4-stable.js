const http = require("http");
const WebSocket = require("ws");
const fs = require("fs");
const path = require("path");

// HTTP SERVER
const httpServer = http.createServer((req, res) => {
  // req.url SORGU DIZESINI de icerir. Dogrudan kullanilirsa dosya yolu
  // "./inferno-pool-test.html?v=2" olur ve bulunamaz -> 404. Portallar
  // (CrazyGames, Yandex) oyunu genellikle ?utm_source= gibi parametrelerle
  // actigi icin oyun hic yuklenmezdi. Yalnizca PATH kismini kullan.
  const urlPath = req.url.split('?')[0].split('#')[0];
  let filePath = '.' + (urlPath === '/' ? '/inferno-pool-test.html' : urlPath);
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

// ═══════════════════════════════════════════════════════════════════════
// CHAT V1 — SUNUCU MODULU                              [ASAMA 3, APPEND-ONLY]
// ═══════════════════════════════════════════════════════════════════════
// Bu blok dosyanin SONUNA eklenmistir; yukaridaki hicbir satir
// degistirilmemistir. Oyun tarafiyla tek temas noktasi wss nesnesidir ve
// o da yalnizca YENI dinleyiciler eklemek icin kullanilir.
//
// NEDEN AYRI DINLEYICI:
//   wss / ws birer EventEmitter'dir; ayni olaya birden fazla dinleyici
//   kaydedilebilir. Boylece mevcut wss.on('connection') blogu, onun
//   icindeki ws.on('message') switch'i ve ws.on('close') akisi HIC
//   degistirilmeden chat kendi dinleyicilerini ekler.
//
// NEDEN GUVENLI:
//   * Mevcut router'daki switch(msg.type) bir 'default' dali TASIMAZ;
//     tanimadigi tipleri sessizce yutar. 'chat_' ile baslayan mesajlar
//     oradan zararsiz gecer. (Bu, canli sunucuda olculerek dogrulandi.)
//   * Chat dinleyicisi ILK IS olarak tipi kontrol eder ve 'chat_' ile
//     baslamayan HER mesaji aninda birakir; oyun mesajlarina dokunmaz.
//   * Chat, oyunun rooms/waitingRoom/ws.roomId/ws.slot alanlarini ne
//     okur ne yazar. Kendi durumunu ayri Map'lerde tutar.
//   * Heartbeat'e dokunulmadi: mevcut ws.on('message') dinleyicisi HER
//     mesajda ws.isAlive/ws.lastAppMsg'i tazeledigi icin chat mesajlari
//     da soketi canli tutar. chat_ping ayrica uygulama seviyesinde
//     yanitlanir.

// ── Sinirlar (Render Free: 512 MB RAM, ~0.1 CPU) ──────────────────────
const CHAT_ODA_KAPASITE   = 250;    // oda basina kullanici tavani
const CHAT_GECMIS_MAX     = 100;    // oda basina saklanan mesaj
const CHAT_RAPOR_MAX      = 200;    // bellekteki rapor halka tamponu
const CHAT_MESAJ_MAX      = 250;    // karakter
const CHAT_NICK_MIN       = 3;
const CHAT_NICK_MAX       = 16;
// ── UNICODE NICKNAME  [CHAT V1.1] ──────────────────────────────────────
// ASCII sinirlamasi KALDIRILDI. Artik her yazi sistemi kabul edilir:
// Sahin, Igrok, Japonca, Cince, Arapca, Korece, Yunanca, Hintce, Ibranice,
// Tayca ve emoji iceren adlar dahil.
//
// IZIN VERILEN (beyaz liste — kara liste DEGIL, boylece yeni Unicode
// blogu eklendiginde kendiliginden kapsanir):
//   \p{L}  harf   \p{M}  birlesen isaret (Devanagari/Arapca/Tayca ve
//                          emoji varyasyon seciciler icin ZORUNLU)
//   \p{N}  rakam  _      alt cizgi
//   \p{Extended_Pictographic}  emoji
// REDDEDILEN: bosluk, kontrol karakteri, satir sonu, tab, noktalama ve
// <, >, &, /, " gibi tum isaretler. ZWJ (U+200D) de reddedilir: gorunmez
// oldugu icin ayni gorunen iki farkli nick uretmeye yarardi.
const CHAT_NICK_DESEN = /^[\p{L}\p{M}\p{N}_\p{Extended_Pictographic}]+$/u;

// UZUNLUK KOD NOKTASI ile olculur (UTF-16 birimi ile DEGIL): bir emoji
// tek karakter sayilir. CJK/Kana/Hangul icin alt sinir 2'dir — o
// yazilarda iki karakterlik tam ad olagandir (ornek: iki isaretli Cince
// adlar). Diger yazilarda alt sinir 3 kalir.
const CHAT_NICK_CJK = /[\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF]/;
// Ham girdide kontrol/gorunmez karakter varsa nick REDDEDILIR.
// chatNormalize() bunlari kirptigi icin, kontrol EDILMEZSE "a"+NUL+"bc"
// sessizce "abc" olur ve gecerli sayilirdi. Kural: reddet.
const CHAT_NICK_KONTROL = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028\u2029\uFEFF]/;
function chatNickUzunluk(s){ return Array.from(s).length; }
function chatNickAltSinir(s){ return CHAT_NICK_CJK.test(s) ? 2 : CHAT_NICK_MIN; }

// Latin'e cok benzeyen Kiril/Yunan harfleri. Amac: "Igrok" gorunumlu bir
// nick ile Latin bir nickin ayni odada birbirinin yerine gecmesini
// zorlastirmak. YALNIZCA cakisma anahtarinda kullanilir; kullaniciya
// gosterilen ad HIC DEGISMEZ.
const CHAT_BENZER = {
  '\u0430':'a','\u0432':'b','\u0435':'e','\u043a':'k','\u043c':'m','\u043d':'h','\u043e':'o',
  '\u0440':'p','\u0441':'c','\u0442':'t','\u0443':'y','\u0445':'x','\u0456':'i','\u0455':'s',
  '\u0458':'j','\u04bb':'h','\u0491':'r',
  '\u03b1':'a','\u03b2':'b','\u03b5':'e','\u03b7':'n','\u03b9':'i','\u03ba':'k','\u03bc':'m',
  '\u03bd':'v','\u03bf':'o','\u03c1':'p','\u03c3':'o','\u03c4':'t','\u03c5':'y','\u03c7':'x'
};
// Cakisma anahtari. Adimlar:
//   1) NFKC  — tam/yari genislik ve uyumluluk bicimlerini birlestirir
//   2) toLowerCase — buyuk/kucuk harf duyarsizligi (Unicode farkindalikli)
//   3) YALNIZCA U+0307 (birlesen ustteki nokta) silinir — Turkce buyuk I
//      kucuk harfe cevrilince "i" + U+0307 uretir; bu adim olmadan
//      "SAHIN" ile "Sahin" ayni anahtara dusmezdi.
//      TUM \p{M} isaretlerini silmek DENENDI ve BIRAKILDI: o adim
//      Omer/Omer, Sahin/Sahin, Jose/Jose, Muller/Muller gibi MESRU
//      farkli adlari ayni sayiyor ve Devanagari'de sesli isaretlerini
//      sildigi icin Hintce adlari bozuyordu.
//   4) NFC — kalan isaretler yeniden birlestirilir
//   5) benzer harf katlama — Kiril/Yunan taklitlerini Latin'e indirger
//      (Orion / Kiril-O'lu Orion hala cakisir: taklit korumasi korunur)
function chatNickAnahtar(s){
  let k = String(s);
  try{ k = k.normalize('NFKC'); }catch(e){}
  k = k.toLowerCase();
  k = k.replace(/\u0307/g, '');
  try{ k = k.normalize('NFC'); }catch(e){}
  let c = '';
  for(const ch of k) c += (CHAT_BENZER[ch] || ch);
  return c;
}
const CHAT_HIZ_MS         = 1000;   // en az 1 sn arayla mesaj
const CHAT_PENCERE_MS     = 10000;  // 10 sn penceresi
const CHAT_PENCERE_MAX    = 6;      // pencerede en fazla 6 mesaj
const CHAT_MUTE_MS        = 30000;  // asilirsa 30 sn susturma
const CHAT_TEKRAR_MAX     = 3;      // ayni metin arka arkaya en fazla 2 kez
const CHAT_TEMEL_ODA      = 'global';

// Kufur listesi. Sunucu tarafinda uygulanir; mesaj DUSURULMEZ, eslesme
// maskelenir. Liste kasitli olarak kisa tutuldu; genisletmek icin tek yer.
const CHAT_KUFUR = [
  'fuck','shit','bitch','asshole','bastard','cunt','dick','pussy','whore','slut',
  'nigger','faggot','retard',
  'amk','aq','orospu','piç','pic','yarrak','yarak','sikeyim','siktir','gavat',
  'oc','anasini','ananı','ananin',
  'блядь','блять','сука','хуй','пизда','ебать','ёбан','мудак','пидор'
];

// ── Durum (RAM tabanli; deploy/restart sonrasi sifirlanir) ────────────
const chatRooms   = new Map();   // odaId -> { id, mesajlar:[], uyeler:Set<ws> }
const chatUsers   = new Map();   // ws    -> { nick, nickAlt, oda, sonMs, pencere:[], muteBitis, sonMetin, tekrar }
const chatReports = [];          // en fazla CHAT_RAPOR_MAX kayit

// ── ChatStore — TEK depolama arayuzu ─────────────────────────────────
// Bugun Map/dizi tabanli bellek uygulamasi. Ileride Redis/Postgres'e
// gecerken YALNIZCA bu dort fonksiyonun govdesi degisir; chat mantigi
// dokunulmadan kalir.
const ChatStore = {
  getRoom(odaId){
    let o = chatRooms.get(odaId);
    if(!o){ o = { id: odaId, mesajlar: [], uyeler: new Set() }; chatRooms.set(odaId, o); }
    return o;
  },
  addMessage(odaId, mesaj){
    const o = ChatStore.getRoom(odaId);
    o.mesajlar.push(mesaj);
    // Halka tampon: oda basina yalnizca son CHAT_GECMIS_MAX mesaj.
    if(o.mesajlar.length > CHAT_GECMIS_MAX){
      o.mesajlar.splice(0, o.mesajlar.length - CHAT_GECMIS_MAX);
    }
    return mesaj;
  },
  getUsers(odaId){
    const o = chatRooms.get(odaId);
    if(!o) return [];
    const liste = [];
    o.uyeler.forEach(function(s){
      const u = chatUsers.get(s);
      if(u && u.nick) liste.push(u.nick);
    });
    return liste;
  },
  addReport(rapor){
    chatReports.push(rapor);
    if(chatReports.length > CHAT_RAPOR_MAX){
      chatReports.splice(0, chatReports.length - CHAT_RAPOR_MAX);
    }
    return rapor;
  }
};

// ── Yardimcilar ───────────────────────────────────────────────────────
function chatGonder(ws, veri){
  // Oyun tarafindaki send() ile bilerek AYNI islevde ama AYRI fonksiyon:
  // chat ile oyun arasinda kod baglantisi kalmasin.
  if(ws && ws.readyState === WebSocket.OPEN){
    try{ ws.send(JSON.stringify(veri)); }catch(e){}
  }
}
function chatHata(ws, kod, ek){
  const p = { type:'chat_error', code: kod };
  if(ek) p.detail = ek;
  chatGonder(ws, p);
}
// Oda adi gecerli mi: 'global' veya tasma odalari 'global-2', 'global-3'...
function chatOdaGecerli(id){
  if(typeof id !== 'string') return false;
  if(id === CHAT_TEMEL_ODA) return true;
  return /^global-([2-9]|[1-9][0-9])$/.test(id);
}
// Kapasite dolduysa bir sonraki tasma odasini bul/uret.
function chatOdaBul(){
  let ad = CHAT_TEMEL_ODA;
  for(let i = 1; i <= 20; i++){
    const o = ChatStore.getRoom(ad);
    if(o.uyeler.size < CHAT_ODA_KAPASITE) return ad;
    ad = CHAT_TEMEL_ODA + '-' + (i + 1);
  }
  return null;   // tum odalar dolu
}
// Kontrol karakterlerini temizle, bosluklari sadelestir, kirp.
function chatNormalize(s){
  if(typeof s !== 'string') return '';
  // Kontrol karakterlerini at. CR / LF / TAB HARIC tutulur; onlar bir
  // alt satirda BOSLUGA cevrilir ki "a" + LF + "b" sonucu "ab" degil
  // "a b" olsun.
  let t = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '');
  t = t.replace(/[\r\n\t]+/g, ' ');
  t = t.replace(/\s{2,}/g, ' ');
  return t.trim();
}
// Kufur maskesi: eslesen harfleri *** yapar, mesaji DUSURMEZ.
function chatKufurMaskele(s){
  let t = s;
  for(let i = 0; i < CHAT_KUFUR.length; i++){
    const k = CHAT_KUFUR[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    t = t.replace(new RegExp(k, 'gi'), function(m){ return '*'.repeat(Math.min(m.length, 3)); });
  }
  return t;
}
function chatKufurIceriyor(s){
  const d = String(s).toLowerCase();
  for(let i = 0; i < CHAT_KUFUR.length; i++){
    if(d.indexOf(CHAT_KUFUR[i].toLowerCase()) !== -1) return true;
  }
  return false;
}
// Nickname dogrulama. ISTEMCIYE GUVENILMEZ; her kural sunucuda.
function chatNickDogrula(ham, oda){
  // Kontrol/gorunmez karakter HAM girdide sinanir: normalize onlari
  // kirpacagi icin sonrasinda tespit edilemezlerdi.
  if(typeof ham === 'string' && CHAT_NICK_KONTROL.test(ham)) return { hata:'nick_chars' };
  // NFKC: istemciler ayni adi farkli bicimlerde gonderebilir; once tek
  // bicime indirilir. Sonra kontrol karakteri temizligi (chatNormalize).
  let n = chatNormalize(ham);
  try{ n = n.normalize('NFKC'); }catch(e){}
  const uz = chatNickUzunluk(n);
  if(uz < chatNickAltSinir(n) || uz > CHAT_NICK_MAX) return { hata:'nick_length' };
  if(!CHAT_NICK_DESEN.test(n)) return { hata:'nick_chars' };
  if(chatKufurIceriyor(n)) return { hata:'nick_forbidden' };
  const alt = chatNickAnahtar(n);
  const o = chatRooms.get(oda);
  if(o){
    let cakisma = false;
    o.uyeler.forEach(function(s){
      const u = chatUsers.get(s);
      if(u && u.nickAlt === alt) cakisma = true;
    });
    if(cakisma) return { hata:'nick_taken' };
  }
  return { nick: n, nickAlt: alt };
}
// Yalnizca ILGILI odadaki soketlere yayin (O(N), N = oda uyesi).
function chatYayinla(odaId, veri, haricWs){
  const o = chatRooms.get(odaId);
  if(!o) return 0;
  let n = 0;
  o.uyeler.forEach(function(s){
    if(s === haricWs) return;
    chatGonder(s, veri); n++;
  });
  return n;
}
function chatKullaniciListesiYayinla(odaId){
  chatYayinla(odaId, { type:'chat_users', room: odaId, users: ChatStore.getUsers(odaId) });
}
// Odadan cikar, nickname rezervasyonunu birak, listeyi tazele.
function chatOdadanCikar(ws, bildir){
  const u = chatUsers.get(ws);
  if(!u) return null;
  const odaId = u.oda;
  const o = chatRooms.get(odaId);
  if(o) o.uyeler.delete(ws);
  chatUsers.delete(ws);            // nickname rezervasyonu serbest
  if(odaId && bildir !== false){
    chatYayinla(odaId, { type:'chat_leave', room: odaId, nick: u.nick });
    chatKullaniciListesiYayinla(odaId);
  }
  return u;
}
// Hiz siniri. Donen deger: null = gecebilir, aksi halde hata kodu.
function chatHizKontrol(u, simdi){
  if(u.muteBitis && simdi < u.muteBitis){
    return { hata:'muted', kalan: Math.ceil((u.muteBitis - simdi) / 1000) };
  }
  if(u.sonMs && (simdi - u.sonMs) < CHAT_HIZ_MS) return { hata:'too_fast' };
  u.pencere = u.pencere.filter(function(t){ return simdi - t < CHAT_PENCERE_MS; });
  if(u.pencere.length >= CHAT_PENCERE_MAX){
    u.muteBitis = simdi + CHAT_MUTE_MS;
    return { hata:'muted', kalan: Math.ceil(CHAT_MUTE_MS / 1000) };
  }
  return null;
}

// ── Mesaj isleyicileri ────────────────────────────────────────────────
function chatKatil(ws, msg){
  if(chatUsers.has(ws)) chatOdadanCikar(ws, true);   // yeniden katilim
  let istenen = (msg && typeof msg.room === 'string') ? msg.room : CHAT_TEMEL_ODA;
  if(!chatOdaGecerli(istenen)) return chatHata(ws, 'room_invalid');
  // Istenen oda doluysa tasma odasina yonlendir.
  let oda = istenen;
  if(ChatStore.getRoom(oda).uyeler.size >= CHAT_ODA_KAPASITE){
    oda = chatOdaBul();
    if(!oda) return chatHata(ws, 'room_full');
  }
  const d = chatNickDogrula(msg && msg.nick, oda);
  if(d.hata) return chatHata(ws, d.hata);

  const o = ChatStore.getRoom(oda);
  o.uyeler.add(ws);
  chatUsers.set(ws, { nick:d.nick, nickAlt:d.nickAlt, oda:oda,
                      sonMs:0, pencere:[], muteBitis:0, sonMetin:'', tekrar:0 });

  chatGonder(ws, { type:'chat_join', ok:true, room:oda, nick:d.nick,
                   capacity:CHAT_ODA_KAPASITE, count:o.uyeler.size });
  chatGonder(ws, { type:'chat_history', room:oda, messages:o.mesajlar.slice() });
  chatGonder(ws, { type:'chat_users', room:oda, users:ChatStore.getUsers(oda) });
  chatYayinla(oda, { type:'chat_join', room:oda, nick:d.nick }, ws);
  chatKullaniciListesiYayinla(oda);
}

function chatAyril(ws){
  const u = chatOdadanCikar(ws, true);
  chatGonder(ws, { type:'chat_leave', ok:true, room: u ? u.oda : null });
}

function chatMesaj(ws, msg){
  const u = chatUsers.get(ws);
  if(!u) return chatHata(ws, 'not_joined');
  const simdi = Date.now();

  const hiz = chatHizKontrol(u, simdi);
  if(hiz) return chatHata(ws, hiz.hata, hiz.kalan);

  let metin = chatNormalize(msg && msg.text);
  if(!metin) return chatHata(ws, 'empty');
  if(metin.length > CHAT_MESAJ_MAX) return chatHata(ws, 'too_long');

  // Ayni metnin arka arkaya tekrari.
  if(metin === u.sonMetin){
    u.tekrar++;
    if(u.tekrar >= CHAT_TEKRAR_MAX) return chatHata(ws, 'duplicate');
  } else {
    u.sonMetin = metin; u.tekrar = 1;
  }

  u.sonMs = simdi;
  u.pencere.push(simdi);

  // Kufur maskesi mesaji dusurmez.
  metin = chatKufurMaskele(metin);

  // NOT: metin duz metindir; hicbir yerde HTML olarak yorumlanmaz.
  // Istemci tarafinda da textContent ile yazilacak, innerHTML ile DEGIL.
  const kayit = { nick:u.nick, text:metin, ts:simdi, room:u.oda };
  ChatStore.addMessage(u.oda, kayit);
  chatYayinla(u.oda, { type:'chat_message', room:u.oda, nick:kayit.nick,
                       text:kayit.text, ts:kayit.ts });
}

function chatRapor(ws, msg){
  const u = chatUsers.get(ws);
  if(!u) return chatHata(ws, 'not_joined');
  ChatStore.addReport({
    timestamp: Date.now(),
    reporter:  u.nick,
    reported:  chatNormalize(msg && msg.nick).slice(0, CHAT_NICK_MAX),
    message:   chatNormalize(msg && msg.text).slice(0, CHAT_MESAJ_MAX),
    room:      u.oda
  });
  console.log('CHAT REPORT', u.nick, '->', (msg && msg.nick) || '?', 'room', u.oda);
  chatGonder(ws, { type:'chat_report', ok:true });
}

// BLOCK sunucuda TUTULMAZ; istemci tarafinda localStorage ile yapilacak.
// Bu isleyici yalnizca protokolu tamamlar ve onay doner.
function chatBlokBildirimi(ws, msg){
  const u = chatUsers.get(ws);
  if(!u) return chatHata(ws, 'not_joined');
  chatGonder(ws, { type:'chat_block_notice', ok:true,
                   nick: chatNormalize(msg && msg.nick).slice(0, CHAT_NICK_MAX),
                   note: 'client_side_only' });
}

// ── Yonlendirici ──────────────────────────────────────────────────────
// 'chat_' ile baslamayan HER mesaj aninda birakilir: oyun trafigi bu
// fonksiyondan hicbir sekilde etkilenmez.
// ═══════════════════════════════════════════════════════════════════════
// CHAT V2 — 1:1 OZEL MESAJ (DM) + GECICI DEPOLAMA                [V2]
// ═══════════════════════════════════════════════════════════════════════
// KALICI DEPOLAMA YOK: veritabani, dosya, disk — hicbiri kullanilmaz.
// Her sey YALNIZCA RAM'dedir ve surec yeniden baslayinca SIFIRLANIR.
//
// GLOBAL : en fazla 100 mesaj (mevcut ChatStore.addMessage siniri) +
//          6 saatten eski mesajlar periyodik supurme ile dusurulur.
// DM     : konusma basina 100 mesaj, 24 saat TTL, en fazla 200 aktif
//          konusma; tavan asilirsa EN ESKI DOKUNULAN konusma (LRU) atilir.
//
// DM MESAJLARI GLOBAL AKISA HIC GIRMEZ: ChatStore.addMessage() ve
// chatYayinla() DM yolunda CAGRILMAZ; DM yalnizca iki tarafin soketine
// dogrudan gonderilir. Global mesajlar da DM'e sizmaz.
const CHAT_DM_GECMIS_MAX  = 100;                 // konusma basina mesaj
const CHAT_DM_KONUSMA_MAX = 200;                 // ayni anda tutulan konusma
const CHAT_DM_TTL_MS      = 24 * 60 * 60 * 1000; // 24 saat
const CHAT_GLOBAL_TTL_MS  =  6 * 60 * 60 * 1000; // 6 saat
const CHAT_TEMIZLIK_MS    =  5 * 60 * 1000;      // hafif supurme periyodu

// konusmaId -> { mesajlar: [], sonMs }   (sonMs = LRU icin son dokunma)
const chatDM = new Map();

// Konusma kimligi nick ANAHTARLARINDAN uretilir (chatNickAnahtar), boylece
// buyuk/kucuk harf ve Unicode taklit varyasyonlari ayni konusmaya duser.
function chatDMKonusmaId(a, b){ return 'dm:' + [a, b].sort().join('|'); }

function chatDMKonusma(id, olustur){
  let k = chatDM.get(id);
  if(!k){
    if(!olustur) return null;
    k = { mesajlar: [], sonMs: Date.now() };
    chatDM.set(id, k);
  }
  // LRU: her dokunusta sona tasi.
  chatDM.delete(id); chatDM.set(id, k);
  k.sonMs = Date.now();
  // Tavan asildiysa EN ESKI dokunulan konusmayi dusur.
  while(chatDM.size > CHAT_DM_KONUSMA_MAX){
    const enEski = chatDM.keys().next().value;
    if(enEski === undefined) break;
    chatDM.delete(enEski);
  }
  return k;
}

// Nick anahtarindan CANLI soketi bul. Nickler gecicidir; kullanici
// baglantida degilse null doner -> 'dm_offline'.
function chatSoketBul(anahtar){
  for(const [soket, kayit] of chatUsers){
    if(kayit && kayit.nickAlt === anahtar) return soket;
  }
  return null;
}

// Hedef nicki cozer. Basarisizsa hata kodu dondurur.
function chatDMHedef(ws, u, hamNick){
  let n = chatNormalize(hamNick);
  try{ n = n.normalize('NFKC'); }catch(e){}
  if(!n) return { hata:'dm_target' };
  const anahtar = chatNickAnahtar(n);
  if(anahtar === u.nickAlt) return { hata:'dm_self' };
  const hedefWs = chatSoketBul(anahtar);
  if(!hedefWs) return { hata:'dm_offline' };
  const hedefU = chatUsers.get(hedefWs);
  if(!hedefU) return { hata:'dm_offline' };
  return { ws: hedefWs, u: hedefU, anahtar: anahtar };
}

// chat_dm_open: konusmayi ac, YALNIZCA o konusmanin gecmisini gonder.
function chatDMAc(ws, msg){
  const u = chatUsers.get(ws);
  if(!u) return chatHata(ws, 'not_joined');
  const h = chatDMHedef(ws, u, msg && msg.to);
  if(h.hata) return chatHata(ws, h.hata);
  const id = chatDMKonusmaId(u.nickAlt, h.anahtar);
  const k = chatDMKonusma(id, true);
  chatDMSupur(k);
  chatGonder(ws, { type:'chat_dm_history', with: h.u.nick, messages: k.mesajlar.slice() });
}

// chat_dm: 1:1 mesaj. Global akisa YAZILMAZ, global odaya YAYILMAZ.
function chatDMMesaj(ws, msg){
  const u = chatUsers.get(ws);
  if(!u) return chatHata(ws, 'not_joined');
  const simdi = Date.now();

  // ORTAK hiz limiti / mute: DM ile global sinirlari asilamaz.
  const hiz = chatHizKontrol(u, simdi);
  if(hiz) return chatHata(ws, hiz.hata, hiz.kalan);

  const h = chatDMHedef(ws, u, msg && msg.to);
  if(h.hata) return chatHata(ws, h.hata);

  let metin = chatNormalize(msg && msg.text);
  if(!metin) return chatHata(ws, 'empty');
  if(metin.length > CHAT_MESAJ_MAX) return chatHata(ws, 'too_long');

  u.sonMs = simdi;
  u.pencere.push(simdi);

  metin = chatKufurMaskele(metin);          // global ile ayni filtre

  const id = chatDMKonusmaId(u.nickAlt, h.anahtar);
  const k = chatDMKonusma(id, true);
  chatDMSupur(k);
  const kayit = { from: u.nick, to: h.u.nick, text: metin, ts: simdi };
  k.mesajlar.push(kayit);
  if(k.mesajlar.length > CHAT_DM_GECMIS_MAX){
    k.mesajlar.splice(0, k.mesajlar.length - CHAT_DM_GECMIS_MAX);
  }

  // Yalnizca iki tarafa: gonderene 'with' = alici, aliciya 'with' = gonderen.
  chatGonder(ws,   { type:'chat_dm_message', with: h.u.nick, from: u.nick,
                     text: kayit.text, ts: kayit.ts, mine: true });
  if(h.ws !== ws){
    chatGonder(h.ws, { type:'chat_dm_message', with: u.nick, from: u.nick,
                       text: kayit.text, ts: kayit.ts, mine: false });
  }
}

// ── GECICI DEPOLAMA SUPURMESI ─────────────────────────────────────────
function chatDMSupur(k){
  if(!k || !k.mesajlar.length) return;
  const sinir = Date.now() - CHAT_DM_TTL_MS;
  if(k.mesajlar[0].ts >= sinir) return;              // en eski bile taze
  k.mesajlar = k.mesajlar.filter(function(m){ return m.ts >= sinir; });
}

// Hafif periyodik temizlik: 5 dakikada bir, oda sayisi ve mesaj sayisi
// zaten tavanli oldugu icin maliyeti ihmal edilebilir.
function chatTemizlik(){
  const simdi = Date.now();
  const gSinir = simdi - CHAT_GLOBAL_TTL_MS;
  chatRooms.forEach(function(oda){
    if(oda.mesajlar.length && oda.mesajlar[0].ts < gSinir){
      oda.mesajlar = oda.mesajlar.filter(function(m){ return m.ts >= gSinir; });
    }
  });
  const dSinir = simdi - CHAT_DM_TTL_MS;
  chatDM.forEach(function(k, id){
    chatDMSupur(k);
    // Konusma tamamen bosaldiysa ve uzun suredir dokunulmadiysa dusur.
    if(!k.mesajlar.length && k.sonMs < dSinir) chatDM.delete(id);
  });
}
const chatTemizlikTimer = setInterval(chatTemizlik, CHAT_TEMIZLIK_MS);
if(chatTemizlikTimer && typeof chatTemizlikTimer.unref === 'function'){
  chatTemizlikTimer.unref();                 // surec kapanisini engellemesin
}
wss.on('close', function(){ clearInterval(chatTemizlikTimer); });

function chatYonlendir(ws, ham){
  let msg;
  try{ msg = JSON.parse(ham); }catch(e){ return; }
  if(!msg || typeof msg.type !== 'string') return;
  if(msg.type.lastIndexOf('chat_', 0) !== 0) return;   // OYUN MESAJI -> DOKUNMA

  switch(msg.type){
    case 'chat_join':          chatKatil(ws, msg); break;
    case 'chat_leave':         chatAyril(ws); break;
    case 'chat_message':       chatMesaj(ws, msg); break;
    case 'chat_report':        chatRapor(ws, msg); break;
    // CHAT V2 — 1:1 DM. Global akisla HICBIR paylasimi yoktur.
    case 'chat_dm_open':       chatDMAc(ws, msg); break;
    case 'chat_dm':            chatDMMesaj(ws, msg); break;
    case 'chat_block_notice':  chatBlokBildirimi(ws, msg); break;
    // Uygulama seviyesi chat heartbeat. Mevcut heartbeat blogu
    // DEGISTIRILMEDI; zaten her mesaj ws.lastAppMsg'i tazeliyor.
    case 'chat_ping':          chatGonder(ws, { type:'chat_pong', ts: Date.now() }); break;
    // Bilinmeyen chat_* tipleri kontrollu reddedilir (sessiz degil).
    default:                   chatHata(ws, 'unknown_type', msg.type);
  }
}

// ── Baglanti kancalari — MEVCUT BLOK DEGISTIRILMEDI ──────────────────
// wss bir EventEmitter oldugu icin ikinci bir 'connection' dinleyicisi
// eklenebilir; mevcut dinleyici aynen calismaya devam eder.
wss.on('connection', function(ws){
  ws.on('message', function(ham){ chatYonlendir(ws, ham); });
  // Ikinci bir 'close' dinleyicisi: oyun tarafindaki close blogunun
  // erken 'return'u bunu ETKILEMEZ, listener'lar bagimsizdir.
  ws.on('close', function(){ chatOdadanCikar(ws, true); });
  ws.on('error', function(){ chatOdadanCikar(ws, true); });
});

console.log('Chat V1 module loaded (rooms cap ' + CHAT_ODA_KAPASITE +
            ', history ' + CHAT_GECMIS_MAX + ', reports ' + CHAT_RAPOR_MAX + ')');
