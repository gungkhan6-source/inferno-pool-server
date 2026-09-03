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
// [FIX] Kisa ve belirsiz terimler kelime ICINDE eslesince masum kelimeleri
// sansurluyordu: 'oc' -> bl(oc)k / unbl(oc)k / (oc)ak, 'pic' -> (pic)ture /
// e(pic) / to(pic), 'aq' -> (aq)ua. Bu terimler artik YALNIZCA TAM KELIME
// olarak eslesir. Listedeki DIGER terimlerin davranisi DEGISMEDI: alt dize
// eslesmesi korunur (fucking, siktirgit, orospucocugu gibi bitisik
// kullanimlar yakalanmaya devam eder).
const CHAT_KUFUR_TAM = ['oc', 'aq', 'pic'];
// Kelime siniri Unicode duyarlidir: harf/rakam komsulugu varsa eslesme YOK.
// Turkce ve Kiril karakterler de harf sayilir (cocuk, ocak, sikayet ...).
function chatKufurDeseni(kelime, bayrak){
  const e = kelime.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if(CHAT_KUFUR_TAM.indexOf(kelime) === -1) return new RegExp(e, bayrak);
  return new RegExp('(?<![\\p{L}\\p{N}])' + e + '(?![\\p{L}\\p{N}])', bayrak + 'u');
}
function chatKufurMaskele(s){
  let t = s;
  for(let i = 0; i < CHAT_KUFUR.length; i++){
    t = t.replace(chatKufurDeseni(CHAT_KUFUR[i], 'gi'),
                  function(m){ return '*'.repeat(Math.min(m.length, 3)); });
  }
  return t;
}
function chatKufurIceriyor(s){
  const d = String(s);
  for(let i = 0; i < CHAT_KUFUR.length; i++){
    if(chatKufurDeseni(CHAT_KUFUR[i], 'i').test(d)) return true;
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
  // [V2.1a] SID kaydi kullanici silinmeden ONCE tazelenir: TTL kopma
  // anindan itibaren isler, boylece kisa kopmalarda ayni SID geri alinir.
  if(u.sid) chatSidDokun(u.sid, u.nickAlt);
  chatUsers.delete(ws);            // nickname rezervasyonu serbest
  if(odaId && bildir !== false){
    chatYayinla(odaId, { type:'chat_leave', room: odaId, nick: u.nick });
    chatKullaniciListesiYayinla(odaId);
  }
  return u;
}
// Hiz siniri. Donen deger: null = gecebilir, aksi halde hata kodu.
function chatHizKontrol(u, simdi){
  // [V2.1d] Moderator mute'u: SID/nick tabanli oldugu icin reconnect
  // sonrasinda da gecerlidir. Anti-spam mute'u (u.muteBitis) DEGISMEDI.
  const modBitis = chatModMuteBitis(u);
  if(modBitis && simdi < modBitis){
    return { hata:'muted', kalan: Math.ceil((modBitis - simdi) / 1000) };
  }
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
  // [V2.1a] Gecici oturum kimligi: gecerli jeton varsa AYNI SID korunur,
  // aksi halde yenisi uretilir. Nick ile SID birbirinden BAGIMSIZDIR.
  const sd = chatSidCoz(msg && msg.sid);
  chatSidDokun(sd.sid, d.nickAlt);
  // [V2.1d] Sureli ban ve kick sonrasi bekleme suresi GIRISTE uygulanir.
  const engel = chatModGirisEngeli(sd.sid, d.nickAlt, Date.now());
  if(engel) return chatHata(ws, engel.kod, engel.kalan);
  chatUsers.set(ws, { nick:d.nick, nickAlt:d.nickAlt, oda:oda, sid:sd.sid,
                      sonMs:0, pencere:[], muteBitis:0, sonMetin:'', tekrar:0 });

  chatGonder(ws, { type:'chat_join', ok:true, room:oda, nick:d.nick,
                   sid: chatSidJeton(sd.sid),
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

// [V2.1c] Nedenli rapor. Eski surum neden tasimiyor, tekrarli raporlari
// ayirt etmiyor ve akis siniri uygulamiyordu; ikisi de burada eklendi.
// Tampon siniri (CHAT_RAPOR_MAX = 200) ve RAM-only mimari DEGISMEDI.
function chatRapor(ws, msg){
  const u = chatUsers.get(ws);
  if(!u) return chatHata(ws, 'not_joined');
  const simdi = Date.now();

  const neden = (msg && typeof msg.reason === 'string') ? msg.reason : '';
  if(!chatRaporNedenGecerli(neden)) return chatHata(ws, 'reason_invalid');

  const h = chatRaporHedef(u, msg && msg.nick);
  if(h.hata) return chatHata(ws, h.hata);

  const sayac = chatRaporSayacAl(u.sid);
  const lim = chatRaporLimit(sayac, simdi);
  if(lim) return chatHata(ws, lim.hata, lim.kalan);

  const kapsam = (msg && msg.scope === 'dm') ? 'dm' : 'global';
  const metin  = chatNormalize(msg && msg.text).slice(0, CHAT_MESAJ_MAX);

  // Ayni raporcu -> ayni hedef, 60 sn icinde: YENI KAYIT ACILMAZ, sayac artar.
  const acik = chatRaporTekrarBul(u.sid, h.nickAlt, simdi);
  let tekrar = false;
  if(acik){
    acik.sayac++;
    acik.sonTs = simdi;
    if(metin) acik.message = metin;      // en son baglam saklanir
    tekrar = true;
  } else {
    ChatStore.addReport({
      // [V2.1d] Moderator paneli kayitlari id ile adresler; durum RAM'de
      // tutulur ve restart sonrasi sifirlanir.
      id:          'r' + (simdi.toString(36)) + Math.floor(Math.random() * 1e6).toString(36),
      durum:       'bekliyor',
      ts:          simdi,
      ilkTs:       simdi,
      sonTs:       simdi,
      sayac:       1,
      reason:      neden,
      scope:       kapsam,
      reporter:    u.nick,
      reporterSid: u.sid,
      reported:    h.nick,
      reportedAlt: h.nickAlt,
      reportedSid: h.sid || null,
      message:     metin,
      room:        u.oda
    });
  }
  sayac.sonMs = simdi;
  sayac.saat.push(simdi);

  // Log KISA tutulur: nick + neden + kapsam. Mesaj govdesi log'a yazilmaz.
  console.log('CHAT REPORT', u.nick, '->', h.nick, '[' + neden + '/' + kapsam + ']',
              tekrar ? '(tekrar)' : '(yeni)');
  chatGonder(ws, { type:'chat_report', ok:true, reason: neden, duplicate: tekrar });
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
  // [V2.1b] 'blocked' YALNIZCA acan kisinin KENDI engelini bildirir.
  // Karsi tarafin engeli buradan SIZMAZ (notr davranis korunur).
  chatGonder(ws, { type:'chat_dm_history', with: h.u.nick,
                   blocked: chatBlokVarMi(u.sid, h.u),
                   messages: k.mesajlar.slice() });
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

  // [V2.1b] Iki yonlu engel. Kendi engelini uygulayan gonderen acik
  // 'dm_blocked' alir; karsi taraf engellendigini OGRENMEZ, notr
  // 'dm_unavailable' doner. Kontrol hiz limitinden SONRADIR: engel,
  // anti-spam penceresini atlatmanin yolu olamaz.
  if(chatBlokVarMi(u.sid, h.u))    return chatHata(ws, 'dm_blocked');
  if(chatBlokVarMi(h.u.sid, u))    return chatHata(ws, 'dm_unavailable');

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
  // [V2.1a] Suresi dolmus SID kayitlari ayni supurmede dusurulur.
  chatSidSupur(simdi);
  // [V2.1b] Suresi dolmus engel kayitlari ayni supurmede dusurulur.
  chatBlokSupur(simdi);
  // [V2.1c] Rapor akis sayaclari ayni supurmede sadelestirilir.
  chatRaporSupur(simdi);
  // [V2.1d] Suresi dolmus mute / ban / kick beklemesi ayni supurmede duser.
  chatModSupur(simdi);
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

// ═══════════════════════════════════════════════════════════════════════
// CHAT V2.1a — GECICI OTURUM KIMLIGI (SID)                        [V2.1a]
// ═══════════════════════════════════════════════════════════════════════
// NEDEN: nick gecicidir; soket kapaninca rezervasyon serbest kalir.
// V2.1b'deki server-side Block ve V2.1d'deki moderator mute/ban'in
// reconnect'ten sag cikabilmesi icin SOKETE degil KISIYE bagli, kisa
// omurlu bir tanimlayici gerekir. Bu asama YALNIZCA o tanimlayiciyi
// kurar; block / report / moderation davranisi EKLENMEZ.
//
// NE DEGILDIR: SID bir kimlik DOGRULAMASI degildir. Tarayici depolamasini
// temizleyen kullanici yeni bir SID alir. Tek garantisi sudur:
// BASKASININ SID'i taklit edilemez (HMAC imzasi). Kendine yeni kimlik
// uretmek serbesttir; hesap sistemi olmadan bu kacinilmazdir.
//
// DEPOLAMA: tablo RAM'dedir, restart'ta sifirlanir (V2 karari korunur).
// GIZLI ANAHTAR YALNIZCA SUNUCUDADIR; istemciye "sid.imza" jetonu gider,
// anahtarin kendisi HICBIR ZAMAN gonderilmez.
const chatCrypto        = require('crypto');
const CHAT_SID_TTL_MS   = 30 * 60 * 1000;   // kopmadan sonra SID kaydinin omru
const CHAT_SID_MAX      = 5000;             // tablo tavani (LRU ile korunur)
const CHAT_SID_IMZA_UZ  = 32;               // hex karakter = 128 bit

// Anahtar: once ortam degiskeni (Render env), yoksa SURECE OZEL rastgele
// anahtar. Ikinci durumda jetonlar yalnizca bu surec boyunca gecerlidir;
// her iki durumda da istemciye anahtar SIZMAZ.
const CHAT_SID_ENV      = (typeof process.env.CHAT_SECRET === 'string' &&
                           process.env.CHAT_SECRET.length >= 16);
const CHAT_SID_SECRET   = CHAT_SID_ENV ? process.env.CHAT_SECRET
                                       : chatCrypto.randomBytes(32).toString('hex');

const chatSid = new Map();   // sid -> { nickAlt, sonGorulme }

function chatSidImza(sid){
  return chatCrypto.createHmac('sha256', CHAT_SID_SECRET)
                   .update(sid).digest('hex').slice(0, CHAT_SID_IMZA_UZ);
}
function chatSidUret(){ return chatCrypto.randomBytes(16).toString('hex'); }
function chatSidJeton(sid){ return sid + '.' + chatSidImza(sid); }

// Jetonu dogrular. Bozuk imza -> null. Karsilastirma SABIT ZAMANLIDIR.
function chatSidDogrula(jeton){
  if(typeof jeton !== 'string' || jeton.length > 128) return null;
  const i = jeton.indexOf('.');
  if(i <= 0) return null;
  const sid = jeton.slice(0, i), imza = jeton.slice(i + 1);
  if(!/^[0-9a-f]{32}$/.test(sid)) return null;
  if(imza.length !== CHAT_SID_IMZA_UZ || !/^[0-9a-f]+$/.test(imza)) return null;
  const a = Buffer.from(imza, 'utf8');
  const b = Buffer.from(chatSidImza(sid), 'utf8');
  if(a.length !== b.length) return null;
  try{ if(!chatCrypto.timingSafeEqual(a, b)) return null; }catch(e){ return null; }
  return sid;
}

// LRU + TTL tablosu: dokunulan kayit sona alinir, tavan asilirsa EN ESKI
// dokunulan kayit dusurulur. YENI ZAMANLAYICI YOKTUR; supurme mevcut
// chatTemizlik() icinde yapilir.
function chatSidDokun(sid, nickAlt){
  let k = chatSid.get(sid);
  if(k) chatSid.delete(sid);
  else  k = { nickAlt: '', sonGorulme: 0 };
  if(nickAlt) k.nickAlt = nickAlt;
  k.sonGorulme = Date.now();
  chatSid.set(sid, k);
  while(chatSid.size > CHAT_SID_MAX){
    const enEski = chatSid.keys().next();
    if(enEski.done) break;
    chatSid.delete(enEski.value);
  }
  return k;
}

// chat_join'daki jetonu cozer.
//   gecerli imza + yasayan kayit -> AYNI SID korunur      (reconnect)
//   imza bozuk / jeton yok       -> YENI SID              (sessizce)
//   TTL dolmus / kayit dusmus    -> YENI SID              (kimlik yenilenir)
function chatSidCoz(jeton){
  const sid = chatSidDogrula(jeton);
  if(!sid) return { sid: chatSidUret(), yeni: true, sebep: jeton ? 'invalid' : 'none' };
  const k = chatSid.get(sid);
  if(!k) return { sid: chatSidUret(), yeni: true, sebep: 'expired' };
  if((Date.now() - k.sonGorulme) > CHAT_SID_TTL_MS){
    chatSid.delete(sid);
    return { sid: chatSidUret(), yeni: true, sebep: 'expired' };
  }
  return { sid: sid, yeni: false, sebep: 'ok' };
}
function chatSidSupur(simdi){
  const sinir = simdi - CHAT_SID_TTL_MS;
  chatSid.forEach(function(k, sid){ if(k.sonGorulme < sinir) chatSid.delete(sid); });
}
console.log('Chat V2.1a SID ready (ttl ' + (CHAT_SID_TTL_MS / 60000) + ' min, cap ' +
            CHAT_SID_MAX + ', secret ' + (CHAT_SID_ENV ? 'env' : 'ephemeral') + ')');

// ═══════════════════════════════════════════════════════════════════════
// CHAT V2.1b — SUNUCU TARAFI BLOCK (ENGELLEME)                   [V2.1b]
// ═══════════════════════════════════════════════════════════════════════
// KAPSAM: YALNIZCA 1:1 DM. Global sohbet BILEREK etkilenmez; engelleyen
// ve engellenen kullanicilar global odada birbirlerinin mesajlarini
// gormeye DEVAM EDER (urun karari).
//
// KIMLIK: birincil anahtar V2.1a'daki SID'dir. nickAlt YALNIZCA yedek
// eslestirmedir: engellenen kisi yeni bir SID ile ayni nick'e donerse
// engel yine uygulanir. Nick geri donusumunden dogabilecek yanlis
// pozitifi sinirlamak icin kayitlarin TTL'i vardir.
//
// DEPOLAMA: RAM. Kisi basi 100 kayit, toplam 2000 kayit, 24 saat TTL,
// tavan asilirsa EN ESKI kayit dusurulur (LRU). Supurme mevcut
// chatTemizlik() icinde yapilir; YENI ZAMANLAYICI EKLENMEZ.
//
// SIZINTI KURALI: engellenen kisiye engellendigi SOYLENMEZ. Kendi
// engelini uygulayan gonderen 'dm_blocked', karsi taraf notr
// 'dm_unavailable' alir.
const CHAT_BLOK_KISI_MAX   = 100;                  // bir kullanicinin engel sayisi
const CHAT_BLOK_TOPLAM_MAX = 2000;                 // sunucudaki toplam kayit
const CHAT_BLOK_TTL_MS     = 24 * 60 * 60 * 1000;  // 24 saat
const CHAT_BLOK_HIZ_MS     = 500;                  // ardisik block/unblock araligi

// sahipSid -> Map(anahtar -> { sid, nickAlt, nick, ts })
// anahtar: hedef cevrimiciyse 's:'+sid, degilse 'n:'+nickAlt
const chatBloklar = new Map();
let chatBlokSayac = 0;                             // toplam kayit sayisi

function chatBlokAnahtar(hedef){
  return hedef.sid ? ('s:' + hedef.sid) : ('n:' + hedef.nickAlt);
}
// Toplam tavan asildiginda EN ESKI kayit dusurulur (nadir yol; O(toplam)).
function chatBlokTavanUygula(){
  while(chatBlokSayac > CHAT_BLOK_TOPLAM_MAX){
    let enEskiSahip = null, enEskiAnahtar = null, enEskiTs = Infinity;
    chatBloklar.forEach(function(harita, sahip){
      harita.forEach(function(kayit, anahtar){
        if(kayit.ts < enEskiTs){ enEskiTs = kayit.ts; enEskiSahip = sahip; enEskiAnahtar = anahtar; }
      });
    });
    if(enEskiSahip === null) break;
    const h = chatBloklar.get(enEskiSahip);
    if(h && h.delete(enEskiAnahtar)) chatBlokSayac--;
    if(h && h.size === 0) chatBloklar.delete(enEskiSahip);
  }
}
// Engel hedefini cozer: cevrimici ise SID + nickAlt, degilse yalnizca
// nickAlt ile kaydedilir. Nick dogrulamasi chat_join ile AYNI kurallardir.
function chatBlokHedef(u, hamNick){
  let nick = chatNormalize(hamNick);
  try{ nick = nick.normalize('NFKC'); }catch(e){}
  if(!nick) return { hata:'block_target' };
  const uz = chatNickUzunluk(nick);
  if(uz < chatNickAltSinir(nick) || uz > CHAT_NICK_MAX) return { hata:'block_target' };
  if(!CHAT_NICK_DESEN.test(nick)) return { hata:'block_target' };
  const anahtar = chatNickAnahtar(nick);
  if(anahtar === u.nickAlt) return { hata:'block_self' };
  const hedefWs = chatSoketBul(anahtar);
  const hedefU = hedefWs ? chatUsers.get(hedefWs) : null;
  return { sid: hedefU ? hedefU.sid : null, nickAlt: anahtar,
           nick: hedefU ? hedefU.nick : nick };
}
// Iki yonlu kontrolde kullanilir: sahip, hedefi engellemis mi?
// Once SID (O(1) benzeri), sonra nickAlt yedegi (en fazla 100 kayit).
function chatBlokVarMi(sahipSid, hedefU){
  if(!sahipSid || !hedefU) return false;
  const harita = chatBloklar.get(sahipSid);
  if(!harita || harita.size === 0) return false;
  const simdi = Date.now();
  let bulundu = false;
  harita.forEach(function(kayit, anahtar){
    if(bulundu) return;
    if((simdi - kayit.ts) > CHAT_BLOK_TTL_MS){ harita.delete(anahtar); chatBlokSayac--; return; }
    if(kayit.sid && hedefU.sid && kayit.sid === hedefU.sid) bulundu = true;
    else if(kayit.nickAlt && kayit.nickAlt === hedefU.nickAlt) bulundu = true;
  });
  if(harita.size === 0) chatBloklar.delete(sahipSid);
  return bulundu;
}
// Hafif hiz koruması: block/unblock akisi global mesaj penceresini
// TUKETMEZ, ayri ve cok basit bir aralik kontrolu kullanir.
function chatBlokHizAsildi(u, simdi){
  if(u.sonBlokMs && (simdi - u.sonBlokMs) < CHAT_BLOK_HIZ_MS) return true;
  u.sonBlokMs = simdi;
  return false;
}
function chatBlokListesiGonder(ws, u){
  const harita = chatBloklar.get(u.sid);
  const nickler = [];
  if(harita) harita.forEach(function(kayit){ nickler.push(kayit.nick); });
  chatGonder(ws, { type:'chat_block_list', nicks: nickler });
}

function chatBlokEkle(ws, msg){
  const u = chatUsers.get(ws);
  if(!u) return chatHata(ws, 'not_joined');
  const simdi = Date.now();
  if(chatBlokHizAsildi(u, simdi)) return chatHata(ws, 'too_fast');
  const h = chatBlokHedef(u, msg && msg.nick);
  if(h.hata) return chatHata(ws, h.hata);

  let harita = chatBloklar.get(u.sid);
  if(!harita){ harita = new Map(); chatBloklar.set(u.sid, harita); }
  const anahtar = chatBlokAnahtar(h);
  if(!harita.has(anahtar)){
    if(harita.size >= CHAT_BLOK_KISI_MAX) return chatHata(ws, 'block_limit');
    chatBlokSayac++;
  }
  harita.set(anahtar, { sid: h.sid, nickAlt: h.nickAlt, nick: h.nick, ts: simdi });
  chatBlokTavanUygula();
  chatGonder(ws, { type:'chat_block_ok', nick: h.nick, blocked: true });
  chatBlokListesiGonder(ws, u);
}

function chatBlokKaldir(ws, msg){
  const u = chatUsers.get(ws);
  if(!u) return chatHata(ws, 'not_joined');
  const simdi = Date.now();
  if(chatBlokHizAsildi(u, simdi)) return chatHata(ws, 'too_fast');
  const h = chatBlokHedef(u, msg && msg.nick);
  if(h.hata) return chatHata(ws, h.hata);

  const harita = chatBloklar.get(u.sid);
  if(harita){
    // Ayni kisi hem SID hem nick anahtariyla kayitli olabilir: TUMU silinir.
    const silinecek = [];
    harita.forEach(function(kayit, anahtar){
      if(kayit.nickAlt === h.nickAlt || (h.sid && kayit.sid === h.sid)) silinecek.push(anahtar);
    });
    silinecek.forEach(function(a){ if(harita.delete(a)) chatBlokSayac--; });
    if(harita.size === 0) chatBloklar.delete(u.sid);
  }
  chatGonder(ws, { type:'chat_block_ok', nick: h.nick, blocked: false });
  chatBlokListesiGonder(ws, u);
}

function chatBlokListe(ws){
  const u = chatUsers.get(ws);
  if(!u) return chatHata(ws, 'not_joined');
  chatBlokListesiGonder(ws, u);
}
// Suresi dolmus kayitlari dusurur (chatTemizlik icinden cagrilir).
function chatBlokSupur(simdi){
  const sinir = simdi - CHAT_BLOK_TTL_MS;
  chatBloklar.forEach(function(harita, sahip){
    harita.forEach(function(kayit, anahtar){
      if(kayit.ts < sinir){ harita.delete(anahtar); chatBlokSayac--; }
    });
    if(harita.size === 0) chatBloklar.delete(sahip);
  });
}

// ═══════════════════════════════════════════════════════════════════════
// CHAT V2.1c — RAPORLAMA (NEDENLI)                              [V2.1c]
// ═══════════════════════════════════════════════════════════════════════
// AMAC: mevcut rapor akisini gercekten kullanilabilir hale getirmek.
// Rapor artik NEDEN tasir, tekrarli raporlar ayri kayit acmaz (sayac
// artar) ve raporcu basina akis sinirlari vardir.
//
// DEPOLAMA: mevcut RAM tamponu (CHAT_RAPOR_MAX = 200) AYNEN korunur.
// Yeni veritabani, dosya veya kalici depolama YOKTUR.
//
// KISISEL VERI: kayitta IP, konum, tarayici bilgisi TUTULMAZ. Yalnizca
// moderasyon icin gereken baglam saklanir: nickler, SID'in ilk 8
// karakteri (ayni kisiyi eslestirmek icin), oda, kapsam (global/dm),
// neden, zaman damgalari ve raporlanan mesaj metni.
//
// KIMLIK: raporcu, V2.1a'daki imzali SID ile taninir; boylece akis
// sinirlari reconnect ile sifirlanmaz. Block sistemi ile hicbir
// baglantisi yoktur: rapor DM'i veya global'i ENGELLEMEZ.
const CHAT_RAPOR_NEDENLERI  = ['spam','harassment','inappropriate','scam','other'];
const CHAT_RAPOR_HIZ_MS     = 10000;          // raporcu basina en az aralik
const CHAT_RAPOR_SAAT_MS    = 60 * 60 * 1000; // saatlik pencere
const CHAT_RAPOR_SAAT_MAX   = 10;             // pencerede en fazla rapor
const CHAT_RAPOR_TEKRAR_MS  = 60000;          // ayni cift icin tekrar penceresi
const CHAT_RAPOR_SAYAC_MAX  = 2000;           // sayac tablosu tavani (LRU)

// raporcuSid -> { sonMs, saat:[ts,...] }
const chatRaporSayaclar = new Map();

function chatRaporNedenGecerli(r){
  return typeof r === 'string' && CHAT_RAPOR_NEDENLERI.indexOf(r) >= 0;
}
// Raporcunun akis durumunu dondurur (LRU: dokunulan kayit sona alinir).
function chatRaporSayacAl(sid){
  let k = chatRaporSayaclar.get(sid);
  if(k) chatRaporSayaclar.delete(sid);
  else  k = { sonMs: 0, saat: [] };
  chatRaporSayaclar.set(sid, k);
  while(chatRaporSayaclar.size > CHAT_RAPOR_SAYAC_MAX){
    const enEski = chatRaporSayaclar.keys().next();
    if(enEski.done) break;
    chatRaporSayaclar.delete(enEski.value);
  }
  return k;
}
// Akis sinirlari: 1 rapor / 10 sn ve 10 rapor / saat.
// Donen deger: null = gecebilir, aksi halde hata kodu.
function chatRaporLimit(k, simdi){
  if(k.sonMs && (simdi - k.sonMs) < CHAT_RAPOR_HIZ_MS){
    return { hata:'report_rate', kalan: Math.ceil((CHAT_RAPOR_HIZ_MS - (simdi - k.sonMs)) / 1000) };
  }
  k.saat = k.saat.filter(function(t){ return (simdi - t) < CHAT_RAPOR_SAAT_MS; });
  if(k.saat.length >= CHAT_RAPOR_SAAT_MAX){
    return { hata:'report_limit', kalan: CHAT_RAPOR_SAAT_MAX };
  }
  return null;
}
// Ayni raporcu -> ayni hedef cifti icin acik kayit (60 sn icinde).
function chatRaporTekrarBul(raporcuSid, hedefAlt, simdi){
  for(let i = chatReports.length - 1; i >= 0; i--){
    const r = chatReports[i];
    if(r.reporterSid === raporcuSid && r.reportedAlt === hedefAlt){
      return ((simdi - r.sonTs) < CHAT_RAPOR_TEKRAR_MS) ? r : null;
    }
  }
  return null;
}
// Rapor hedefini cozer. Nick kurallari chat_join ile AYNIDIR; hedef
// cevrimdisi olsa bile rapor alinabilir (mesaj sonrasi ayrilmis olabilir).
function chatRaporHedef(u, hamNick){
  let nick = chatNormalize(hamNick);
  try{ nick = nick.normalize('NFKC'); }catch(e){}
  if(!nick) return { hata:'report_target' };
  const uz = chatNickUzunluk(nick);
  if(uz < chatNickAltSinir(nick) || uz > CHAT_NICK_MAX) return { hata:'report_target' };
  if(!CHAT_NICK_DESEN.test(nick)) return { hata:'report_target' };
  const anahtar = chatNickAnahtar(nick);
  if(anahtar === u.nickAlt) return { hata:'report_self' };
  const hedefWs = chatSoketBul(anahtar);
  const hedefU = hedefWs ? chatUsers.get(hedefWs) : null;
  return { sid: hedefU ? hedefU.sid : null, nickAlt: anahtar,
           nick: hedefU ? hedefU.nick : nick };
}
function chatRaporSupur(simdi){
  chatRaporSayaclar.forEach(function(k, sid){
    k.saat = k.saat.filter(function(t){ return (simdi - t) < CHAT_RAPOR_SAAT_MS; });
    if(!k.saat.length && (simdi - k.sonMs) > CHAT_RAPOR_SAAT_MS) chatRaporSayaclar.delete(sid);
  });
}

// ═══════════════════════════════════════════════════════════════════════
// CHAT V2.1d — MODERATOR / ADMIN YETKISI + MUTE / KICK / TEMP BAN [V2.1d]
// ═══════════════════════════════════════════════════════════════════════
// YETKI MODELI:
//   * Yetki YALNIZCA process.env icindeki paylasimli sirlarla verilir:
//     CHAT_MOD_TOKEN (moderator) ve CHAT_ADMIN_TOKEN (admin).
//   * Nick'e, SID'e veya istemci iddiasina gore ASLA yetki verilmez.
//   * Ilgili env YOKSA o rol TAMAMEN KAPALIDIR (fail-closed). Varsayilan
//     parola, gomulu sir veya "gelistirme modu" YOKTUR.
//   * Rol basarili dogrulamadan sonra YALNIZCA o WebSocket baglantisina
//     yazilir (u.rol). Baglanti kopunca rol de gider; reconnect sonrasi
//     yeniden dogrulama gerekir.
//   * HER moderasyon komutu, calismadan once u.rol'u YENIDEN kontrol
//     eder; auth anindaki kontrol yeterli sayilmaz.
//   * Token HICBIR log satirinda, hata mesajinda veya istemciye giden
//     pakette yer almaz.
//
// PERMANENT BAN YOKTUR. Yalnizca sureli (temporary) ban vardir.
//
// DEPOLAMA: her sey RAM'dedir; veritabani, dosya, disk kullanilmaz.
// Restart / redeploy tum mute, ban, kick bekleme ve rapor durumlarini
// sifirlar. Supurme MEVCUT 5 dakikalik chatTemizlik() icinde yapilir;
// yeni surekli zamanlayici EKLENMEZ.
const CHAT_MOD_TOKEN   = (typeof process.env.CHAT_MOD_TOKEN === 'string' &&
                          process.env.CHAT_MOD_TOKEN.length >= 8)
                         ? process.env.CHAT_MOD_TOKEN : null;
const CHAT_ADMIN_TOKEN = (typeof process.env.CHAT_ADMIN_TOKEN === 'string' &&
                          process.env.CHAT_ADMIN_TOKEN.length >= 8)
                         ? process.env.CHAT_ADMIN_TOKEN : null;

// [BUG-FIX #5] SERT KILIT KALDIRILDI. Yanlis denemeler artik REDDEDILMEZ,
// KADEMELI OLARAK GECIKTIRILIR; dogru token her zaman kabul edilir.
// Merdiven: 0.4 / 1 / 2 / 4 / 8 / 15 / 30 sn — tavan 30 sn.
const CHAT_MOD_GECIKME = [400, 1000, 2000, 4000, 8000, 15000, 30000];
const CHAT_MOD_PENCERE_MS   = 10 * 60 * 1000;       // ceza penceresi (sonra sifirlanir)
const CHAT_MOD_GECIKME_MS   = CHAT_MOD_GECIKME[0];  // ilk/temiz kova gecikmesi
const CHAT_MOD_BEKLEYEN_MAX = 3;                    // kova basina eszamanli bekleyen
const CHAT_MOD_DENEME_KAYIT = 5000;                 // deneme tablosu tavani (LRU)
const CHAT_MOD_MUTE_MAX_MS  = 60 * 60 * 1000;       // moderator mute tavani
const CHAT_MOD_BAN_MAX_MS   = 24 * 60 * 60 * 1000;  // temp ban tavani
const CHAT_KICK_BEKLEME_MS  = 60 * 1000;            // kick sonrasi rejoin engeli
const CHAT_MOD_STORE_MAX    = 500;                  // mute/ban tablo tavani
const CHAT_MOD_RAPOR_LIMIT  = 50;                   // panele gonderilen rapor

// anahtar -> { bitis, sebep, veren, ts }   (anahtar: 's:'+sid | 'n:'+nickAlt)
const chatModMute     = new Map();
const chatModBan      = new Map();
const chatKickBekleme = new Map();   // anahtar -> bitis (ms)
// ipHash -> { sayi, ilk, sonMs, bekleyen }   (HAM IP TUTULMAZ; KILIT YOK)
const chatModDeneme   = new Map();

// Bir kullanicinin iki anahtari: SID (birincil) ve nickAlt (yedek).
function chatModAnahtarlar(sid, nickAlt){
  const a = [];
  if(sid) a.push('s:' + sid);
  if(nickAlt) a.push('n:' + nickAlt);
  return a;
}
function chatModTabloYaz(tablo, anahtarlar, kayit){
  anahtarlar.forEach(function(a){
    if(tablo.has(a)) tablo.delete(a);
    tablo.set(a, kayit);
  });
  while(tablo.size > CHAT_MOD_STORE_MAX){
    const enEski = tablo.keys().next();
    if(enEski.done) break;
    tablo.delete(enEski.value);
  }
}
function chatModTabloSil(tablo, anahtarlar){
  let n = 0;
  anahtarlar.forEach(function(a){ if(tablo.delete(a)) n++; });
  return n;
}
function chatModTabloBul(tablo, anahtarlar, simdi){
  for(let i = 0; i < anahtarlar.length; i++){
    const k = tablo.get(anahtarlar[i]);
    if(!k) continue;
    if(k.bitis && simdi >= k.bitis){ tablo.delete(anahtarlar[i]); continue; }
    return k;
  }
  return null;
}
// chatHizKontrol tarafindan cagrilir: moderator mute'u bitis zamani.
function chatModMuteBitis(u){
  if(!u) return 0;
  const k = chatModTabloBul(chatModMute, chatModAnahtarlar(u.sid, u.nickAlt), Date.now());
  return k ? k.bitis : 0;
}
// chatKatil tarafindan cagrilir: giris engeli var mi?
function chatModGirisEngeli(sid, nickAlt, simdi){
  const anah = chatModAnahtarlar(sid, nickAlt);
  const ban = chatModTabloBul(chatModBan, anah, simdi);
  if(ban) return { kod:'banned', kalan: Math.ceil((ban.bitis - simdi) / 1000) };
  for(let i = 0; i < anah.length; i++){
    const bitis = chatKickBekleme.get(anah[i]);
    if(!bitis) continue;
    if(simdi >= bitis){ chatKickBekleme.delete(anah[i]); continue; }
    return { kod:'kick_cooldown', kalan: Math.ceil((bitis - simdi) / 1000) };
  }
  return null;
}

// ── Yetki dogrulama ──────────────────────────────────────────────────
// Sabit zamanli karsilastirma. Uzunluk farki da sizinti olmasin diye
// once uzunluk kontrol edilir, sonra timingSafeEqual calistirilir.
function chatModTokenEsit(girilen, dogru){
  if(typeof girilen !== 'string' || typeof dogru !== 'string') return false;
  const a = Buffer.from(girilen, 'utf8');
  const b = Buffer.from(dogru, 'utf8');
  if(a.length !== b.length) return false;
  try{ return chatCrypto.timingSafeEqual(a, b); }catch(e){ return false; }
}
// [BUG-FIX #5] Tablo artik GERCEK LRU: dokunulan kayit delete+set ile sona
// alinir, tavan asilinca ONCE CEZASIZ (sayi === 0) en eski kayitlar duser.
// Boylece saldirgan tabloyu doldurup kendi cezasini kolayca itemez.
function chatModTavanUygula(){
  if(chatModDeneme.size <= CHAT_MOD_DENEME_KAYIT) return;
  // 1. tur: cezasiz kayitlar (ekleme sirasina gore en eskiden baslar)
  for(const [a, k] of chatModDeneme){
    if(chatModDeneme.size <= CHAT_MOD_DENEME_KAYIT) return;
    if(!k.sayi) chatModDeneme.delete(a);
  }
  // 2. tur: hala tasiyorsa en eski dokunulan kayit duser
  while(chatModDeneme.size > CHAT_MOD_DENEME_KAYIT){
    const enEski = chatModDeneme.keys().next();
    if(enEski.done) break;
    chatModDeneme.delete(enEski.value);
  }
}
function chatModDenemeDurum(ipHash, simdi){
  let k = chatModDeneme.get(ipHash);
  if(k) chatModDeneme.delete(ipHash);            // LRU: sona tasinacak
  else  k = { sayi: 0, ilk: simdi, sonMs: 0, bekleyen: 0 };
  // Ceza penceresi gectiyse sayac sifirlanir (kilit YOK).
  if(k.sayi && (simdi - (k.sonMs || k.ilk)) > CHAT_MOD_PENCERE_MS){
    k.sayi = 0; k.ilk = simdi;
  }
  chatModDeneme.set(ipHash, k);
  chatModTavanUygula();
  return k;
}
// Basarisiz deneme sayisina gore gecikme (tavan 30 sn).
// Sayisal olmayan / negatif girdi ilk kademeye (400 ms) duser.
function chatModGecikme(sayi){
  const s = Number(sayi);
  const i = (!isFinite(s) || s < 0) ? 0
          : Math.min(Math.floor(s), CHAT_MOD_GECIKME.length - 1);
  return CHAT_MOD_GECIKME[i];
}
function chatModAuth(ws, msg){
  const u = chatUsers.get(ws);
  if(!u) return chatHata(ws, 'not_joined');
  const simdi = Date.now();
  const ipHash = ws.__chatIpHash || 'bilinmeyen';
  const d = chatModDenemeDurum(ipHash, simdi);

  // [BUG-FIX #5] Eszamanli bekleyen dogrulama tavani: gecikme setTimeout ile
  // uygulandigi icin ayni kovadan sinirsiz bekleyen istek birikmesin.
  // Event loop BLOKLANMAZ; yalnizca yanit ertelenir.
  if(d.bekleyen >= CHAT_MOD_BEKLEYEN_MAX){
    return chatHata(ws, 'mod_rate', Math.ceil(chatModGecikme(d.sayi) / 1000));
  }
  // Hicbir token tanimli degilse sistem KAPALIDIR (fail-closed).
  if(!CHAT_MOD_TOKEN && !CHAT_ADMIN_TOKEN){
    return setTimeout(function(){ chatHata(ws, 'mod_disabled'); }, CHAT_MOD_GECIKME_MS);
  }
  const girilen = (msg && typeof msg.token === 'string') ? msg.token : '';
  let rol = null;
  if(CHAT_ADMIN_TOKEN && chatModTokenEsit(girilen, CHAT_ADMIN_TOKEN)) rol = 'admin';
  else if(CHAT_MOD_TOKEN && chatModTokenEsit(girilen, CHAT_MOD_TOKEN)) rol = 'mod';

  // Gecikme, O ANDAKI basarisiz deneme sayisina gore belirlenir. DOGRU
  // token da ayni gecikmeyi bekler ama HICBIR ZAMAN REDDEDILMEZ.
  const gecikme = chatModGecikme(d.sayi);
  d.bekleyen++;
  setTimeout(function(){
    d.bekleyen--;
    const bitis = Date.now();
    if(!rol){
      d.sayi++;
      d.sonMs = bitis;
      if(d.sayi === CHAT_MOD_GECIKME.length){
        console.log('CHAT MOD AUTH gecikme tavani', ipHash);  // TOKEN LOGLANMAZ
      }
      return chatHata(ws, 'mod_denied', Math.ceil(chatModGecikme(d.sayi) / 1000));
    }
    // [BUG-FIX #5/D] Basarili auth cezayi TEMIZLER.
    d.sayi = 0; d.ilk = bitis; d.sonMs = 0;
    u.rol = rol;                                          // YALNIZ bu baglantiya
    console.log('CHAT MOD AUTH ok', u.nick, rol, ipHash); // TOKEN LOGLANMAZ
    chatGonder(ws, { type:'chat_mod_auth', ok:true, role: rol });
  }, gecikme);
}
// HER moderasyon komutunda cagrilir. 'admin' gerektiren komutlarda
// gerekli='admin' verilir.
function chatModYetki(ws, gerekli){
  const u = chatUsers.get(ws);
  if(!u){ chatHata(ws, 'not_joined'); return null; }
  const rol = u.rol;
  if(rol !== 'mod' && rol !== 'admin'){ chatHata(ws, 'mod_denied'); return null; }
  if(gerekli === 'admin' && rol !== 'admin'){ chatHata(ws, 'mod_denied'); return null; }
  return u;
}
// Moderasyon hedefi: cevrimici degilse de islem yapilabilir (nick yedegi).
function chatModHedef(u, hamNick){
  let nick = chatNormalize(hamNick);
  try{ nick = nick.normalize('NFKC'); }catch(e){}
  if(!nick) return { hata:'mod_target' };
  const uz = chatNickUzunluk(nick);
  if(uz < chatNickAltSinir(nick) || uz > CHAT_NICK_MAX) return { hata:'mod_target' };
  if(!CHAT_NICK_DESEN.test(nick)) return { hata:'mod_target' };
  const anahtar = chatNickAnahtar(nick);
  if(anahtar === u.nickAlt) return { hata:'mod_self' };
  const hedefWs = chatSoketBul(anahtar);
  const hedefU = hedefWs ? chatUsers.get(hedefWs) : null;
  return { ws: hedefWs, u: hedefU, nickAlt: anahtar,
           sid: hedefU ? hedefU.sid : null,
           nick: hedefU ? hedefU.nick : nick };
}
// Moderator hedefi de moderator/admin ise islem reddedilir.
function chatModKorumali(h){ return !!(h.u && (h.u.rol === 'mod' || h.u.rol === 'admin')); }

// ── Komutlar ─────────────────────────────────────────────────────────
function chatModMuteUygula(ws, msg){
  const u = chatModYetki(ws); if(!u) return;
  const h = chatModHedef(u, msg && msg.nick);
  if(h.hata) return chatHata(ws, h.hata);
  if(chatModKorumali(h)) return chatHata(ws, 'mod_protected');
  const simdi = Date.now();
  let dk = Number(msg && msg.minutes);
  if(!isFinite(dk) || dk <= 0) dk = 10;
  let sure = Math.min(dk * 60 * 1000, CHAT_MOD_MUTE_MAX_MS);
  const kayit = { bitis: simdi + sure, sebep: chatNormalize(msg && msg.reason).slice(0, 80),
                  veren: u.rol, ts: simdi };
  chatModTabloYaz(chatModMute, chatModAnahtarlar(h.sid, h.nickAlt), kayit);
  if(h.ws) chatGonder(h.ws, { type:'chat_muted', seconds: Math.ceil(sure / 1000) });
  console.log('CHAT MOD MUTE', u.nick, '->', h.nick, Math.ceil(sure/60000) + 'dk');
  // [FIX] Bilgilendirme alanlari YUKARI yuvarlanmaz: 2 saniyelik mute artik
  // "1 dakika" gorunmez. 'seconds' tam degeri tasir; 'minutes' tam dakika
  // sayisidir (1 dakikadan kisa sureler 0 doner). Gercek sure DEGISMEDI.
  chatGonder(ws, { type:'chat_mod_ok', action:'mute', nick: h.nick,
                   until: kayit.bitis, seconds: Math.round(sure / 1000),
                   minutes: Math.floor(sure / 60000) });
  chatModRaporDurum(msg && msg.reportId, 'islem_yapildi');
}
function chatModUnmute(ws, msg){
  const u = chatModYetki(ws); if(!u) return;
  const h = chatModHedef(u, msg && msg.nick);
  if(h.hata) return chatHata(ws, h.hata);
  chatModTabloSil(chatModMute, chatModAnahtarlar(h.sid, h.nickAlt));
  chatGonder(ws, { type:'chat_mod_ok', action:'unmute', nick: h.nick });
}
function chatModKick(ws, msg){
  const u = chatModYetki(ws); if(!u) return;
  const h = chatModHedef(u, msg && msg.nick);
  if(h.hata) return chatHata(ws, h.hata);
  if(chatModKorumali(h)) return chatHata(ws, 'mod_protected');
  if(!h.ws) return chatHata(ws, 'mod_offline');
  const simdi = Date.now();
  chatModAnahtarlar(h.sid, h.nickAlt).forEach(function(a){
    chatKickBekleme.set(a, simdi + CHAT_KICK_BEKLEME_MS);
  });
  chatGonder(h.ws, { type:'chat_kicked', seconds: Math.ceil(CHAT_KICK_BEKLEME_MS / 1000),
                     reason: chatNormalize(msg && msg.reason).slice(0, 80) });
  chatOdadanCikar(h.ws, true);
  try{ h.ws.close(); }catch(e){}
  console.log('CHAT MOD KICK', u.nick, '->', h.nick);
  chatGonder(ws, { type:'chat_mod_ok', action:'kick', nick: h.nick });
  chatModRaporDurum(msg && msg.reportId, 'islem_yapildi');
}
function chatModBanla(ws, msg){
  const u = chatModYetki(ws); if(!u) return;
  const h = chatModHedef(u, msg && msg.nick);
  if(h.hata) return chatHata(ws, h.hata);
  if(chatModKorumali(h)) return chatHata(ws, 'mod_protected');
  const simdi = Date.now();
  let sa = Number(msg && msg.hours);
  // PERMANENT BAN YOKTUR: sure her zaman pozitif ve tavanla sinirlidir.
  if(!isFinite(sa) || sa <= 0) sa = 1;
  const sure = Math.min(sa * 60 * 60 * 1000, CHAT_MOD_BAN_MAX_MS);
  const kayit = { bitis: simdi + sure, sebep: chatNormalize(msg && msg.reason).slice(0, 80),
                  veren: u.rol, ts: simdi };
  chatModTabloYaz(chatModBan, chatModAnahtarlar(h.sid, h.nickAlt), kayit);
  if(h.ws){
    chatGonder(h.ws, { type:'chat_banned', seconds: Math.ceil(sure / 1000) });
    chatOdadanCikar(h.ws, true);
    try{ h.ws.close(); }catch(e){}
  }
  console.log('CHAT MOD BAN', u.nick, '->', h.nick, Math.ceil(sure/3600000) + 'sa');
  // [FIX] Bilgilendirme alanlari YUKARI yuvarlanmaz: 2 saniyelik ban artik
  // "1 saat" gorunmez. 'seconds' tam degeri tasir; 'hours' tam saat
  // sayisidir (1 saatten kisa sureler 0 doner). Gercek sure DEGISMEDI.
  chatGonder(ws, { type:'chat_mod_ok', action:'ban', nick: h.nick,
                   until: kayit.bitis, seconds: Math.round(sure / 1000),
                   hours: Math.floor(sure / 3600000) });
  chatModRaporDurum(msg && msg.reportId, 'islem_yapildi');
}
function chatModUnban(ws, msg){
  const u = chatModYetki(ws); if(!u) return;
  const h = chatModHedef(u, msg && msg.nick);
  if(h.hata) return chatHata(ws, h.hata);
  const anah = chatModAnahtarlar(h.sid, h.nickAlt);
  chatModTabloSil(chatModBan, anah);
  chatModTabloSil(chatKickBekleme, anah);
  anah.forEach(function(a){ chatKickBekleme.delete(a); });
  chatGonder(ws, { type:'chat_mod_ok', action:'unban', nick: h.nick });
}
// ── Raporlar ─────────────────────────────────────────────────────────
function chatModRaporDurum(id, durum){
  if(!id) return null;
  for(let i = chatReports.length - 1; i >= 0; i--){
    if(chatReports[i].id === id){ chatReports[i].durum = durum; return chatReports[i]; }
  }
  return null;
}
function chatModRaporlar(ws, msg){
  const u = chatModYetki(ws); if(!u) return;
  let n = Number(msg && msg.limit);
  if(!isFinite(n) || n <= 0 || n > CHAT_MOD_RAPOR_LIMIT) n = CHAT_MOD_RAPOR_LIMIT;
  const liste = chatReports.slice(-n).map(function(r){
    return {
      id:        r.id,
      ts:        r.ts,
      sonTs:     r.sonTs,
      reason:    r.reason,
      scope:     r.scope,
      reporter:  r.reporter,
      reported:  r.reported,
      message:   r.message,
      count:     r.sayac,
      status:    r.durum || 'bekliyor',
      room:      r.room
    };
  }).reverse();
  chatGonder(ws, { type:'chat_mod_reports', total: chatReports.length, items: liste });
}
function chatModRaporIsaretle(ws, msg){
  const u = chatModYetki(ws); if(!u) return;
  const durum = (msg && msg.status === 'islem_yapildi') ? 'islem_yapildi'
              : (msg && msg.status === 'incelendi')     ? 'incelendi'
              : (msg && msg.status === 'bekliyor')      ? 'bekliyor' : null;
  if(!durum) return chatHata(ws, 'mod_status');
  const r = chatModRaporDurum(msg && msg.reportId, durum);
  if(!r) return chatHata(ws, 'mod_report');
  chatGonder(ws, { type:'chat_mod_ok', action:'status', reportId: r.id, status: durum });
}
// Suresi dolmus moderasyon kayitlarini dusurur (chatTemizlik icinden).
function chatModSupur(simdi){
  chatModMute.forEach(function(k, a){ if(k.bitis && simdi >= k.bitis) chatModMute.delete(a); });
  chatModBan.forEach(function(k, a){ if(k.bitis && simdi >= k.bitis) chatModBan.delete(a); });
  chatKickBekleme.forEach(function(b, a){ if(simdi >= b) chatKickBekleme.delete(a); });
  // [BUG-FIX #5] Kilit alani kalmadi: penceresi gecmis ve BEKLEYENI OLMAYAN
  // kayitlar dusurulur.
  chatModDeneme.forEach(function(k, a){
    if(k.bekleyen) return;
    if((simdi - (k.sonMs || k.ilk)) > CHAT_MOD_PENCERE_MS) chatModDeneme.delete(a);
  });
}
// ── [V2.1d / BUG-FIX #4] Guvenilir istemci IP kaynagi ────────────────
// NEDEN: eskiden x-forwarded-for'un ILK degeri kullaniliyordu. Cloudflare
// ve Render mevcut XFF basligini EZMEZ, yalnizca sonuna ekler; dolayisiyla
// ilk deger ISTEMCININ yazdigi degerdir. Bu haliyle saldirgan hem kendi
// hiz limitini atlatabilir hem de bir moderatorun kovasini secip onu
// kilitleyebilirdi.
//
// KAYNAK SIRASI (ilk gecerli olan kazanir):
//   1) cf-connecting-ip   — Cloudflare her istekte SET eder, istemci ezemez
//   2) true-client-ip     — ayni amacli ikinci Cloudflare basligi
//   3) x-forwarded-for    — SAGDAN taranir; istemcinin ekledigi degerler
//      her zaman SOLDA kaldigi icin sagdan ilk gecerli ve OZEL OLMAYAN
//      adres alinir. Boylece hop SAYISINI bilmek gerekmez.
//   4) req.socket.remoteAddress — proxy adresi olabilir; son care.
// Hicbiri gecerli degilse 'bilinmeyen' doner (mevcut davranisla ayni).
//
// NOT: Render/Cloudflare zincirindeki hop sayisi production'da
// DOGRULANMADI; bu yuzden sabit bir pozisyon yerine "sagdan ilk genel
// adres" kurali kullanildi.
//
// HAM IP: yalnizca bu fonksiyonun donusu olarak, cagrildigi yerde HMAC'e
// girdi olur. Hicbir nesnede saklanmaz ve log'a yazilmaz.
const CHAT_IP4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const CHAT_IP6 = /^[0-9a-f:]+$/i;
function chatIpDuzelt(ham){
  let v = String(ham || '').trim();
  if(!v) return '';
  if(v.charAt(0) === '['){                       // [::1]:1234
    const kapa = v.indexOf(']');
    if(kapa > 0) v = v.slice(1, kapa);
  } else if(v.indexOf('.') > 0 && v.indexOf(':') > 0){
    v = v.split(':')[0];                         // 1.2.3.4:5678
  }
  if(v.lastIndexOf('::ffff:', 0) === 0) v = v.slice(7);   // IPv4-mapped IPv6
  return v.trim();
}
function chatIpGecerli(ip){
  if(!ip || ip.length > 45) return false;
  if(CHAT_IP4.test(ip)) return true;
  return ip.indexOf(':') > 0 && CHAT_IP6.test(ip);
}
// Ozel / dahili adresler: proxy hop'lari bunlarla gorunur.
function chatIpOzel(ip){
  if(!ip) return true;
  if(CHAT_IP4.test(ip)){
    const p = ip.split('.').map(Number);
    if(p[0] === 10 || p[0] === 127) return true;
    if(p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
    if(p[0] === 192 && p[1] === 168) return true;
    if(p[0] === 169 && p[1] === 254) return true;
    if(p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true;
    if(p[0] === 0) return true;
    return false;
  }
  const a = ip.toLowerCase();
  if(a === '::' || a === '::1') return true;
  if(a.lastIndexOf('fe8', 0) === 0 || a.lastIndexOf('fe9', 0) === 0 ||
     a.lastIndexOf('fea', 0) === 0 || a.lastIndexOf('feb', 0) === 0) return true;  // fe80::/10
  if(a.charAt(0) === 'f' && (a.charAt(1) === 'c' || a.charAt(1) === 'd')) return true; // fc00::/7
  return false;
}
function chatIstemciIp(req){
  if(!req || !req.headers) return '';
  const b = req.headers;
  // 1-2) Cloudflare basliklari: istemci tarafindan EZILEMEZ.
  const cf = [b['cf-connecting-ip'], b['true-client-ip']];
  for(let i = 0; i < cf.length; i++){
    const v = chatIpDuzelt(cf[i]);
    if(chatIpGecerli(v)) return v;
  }
  // 3) XFF: SAGDAN tara. Istemcinin ekledigi degerler solda kalir.
  const xff = b['x-forwarded-for'];
  if(xff){
    const liste = String(xff).split(',');
    let sagdanGecerli = '';
    for(let i = liste.length - 1; i >= 0; i--){
      const v = chatIpDuzelt(liste[i]);
      if(!chatIpGecerli(v)) continue;
      if(!sagdanGecerli) sagdanGecerli = v;      // bicimi gecerli ilk aday
      if(!chatIpOzel(v)) return v;               // sagdan ilk GENEL adres
    }
    if(sagdanGecerli) return sagdanGecerli;      // hepsi ozelse en sagdaki
  }
  // 4) Son care: proxy adresi olabilir.
  const soket = chatIpDuzelt(req.socket && req.socket.remoteAddress);
  return chatIpGecerli(soket) ? soket : '';
}

console.log('Chat V2.1d moderation ready (mod ' + (CHAT_MOD_TOKEN ? 'env' : 'KAPALI') +
            ', admin ' + (CHAT_ADMIN_TOKEN ? 'env' : 'KAPALI') + ')');

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
    // CHAT V2.1b — sunucu tarafi engelleme. YALNIZCA DM'i etkiler.
    case 'chat_block':         chatBlokEkle(ws, msg); break;
    case 'chat_unblock':       chatBlokKaldir(ws, msg); break;
    case 'chat_block_list':    chatBlokListe(ws); break;
    // CHAT V2.1d — moderasyon. HER komut chatModYetki() ile yeniden
    // kontrol edilir; istemcinin rol iddiasina GUVENILMEZ.
    case 'chat_mod_auth':      chatModAuth(ws, msg); break;
    case 'chat_mod_reports':   chatModRaporlar(ws, msg); break;
    case 'chat_mod_status':    chatModRaporIsaretle(ws, msg); break;
    case 'chat_mod_mute':      chatModMuteUygula(ws, msg); break;
    case 'chat_mod_unmute':    chatModUnmute(ws, msg); break;
    case 'chat_mod_kick':      chatModKick(ws, msg); break;
    case 'chat_mod_ban':       chatModBanla(ws, msg); break;
    case 'chat_mod_unban':     chatModUnban(ws, msg); break;
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
wss.on('connection', function(ws, req){
  // [V2.1d] Brute-force sayaci icin IP'nin HMAC ozeti tutulur; HAM IP
  // hicbir yerde saklanmaz ve log'a yazilmaz.
  try{
    // [BUG-FIX #4] Kaynak sirasi chatIstemciIp() icinde: cf-connecting-ip ->
    // true-client-ip -> XFF'te sagdan ilk genel adres -> remoteAddress.
    // Ham deger DEGISKENDE KALMAZ; dogrudan HMAC'e girer.
    const ham0 = chatIstemciIp(req);
    ws.__chatIpHash = ham0
      ? chatCrypto.createHmac('sha256', CHAT_SID_SECRET).update(ham0).digest('hex').slice(0, 16)
      : 'bilinmeyen';
  }catch(e){ ws.__chatIpHash = 'bilinmeyen'; }
  ws.on('message', function(ham){ chatYonlendir(ws, ham); });
  // Ikinci bir 'close' dinleyicisi: oyun tarafindaki close blogunun
  // erken 'return'u bunu ETKILEMEZ, listener'lar bagimsizdir.
  ws.on('close', function(){ chatOdadanCikar(ws, true); });
  ws.on('error', function(){ chatOdadanCikar(ws, true); });
});

console.log('Chat V1 module loaded (rooms cap ' + CHAT_ODA_KAPASITE +
            ', history ' + CHAT_GECMIS_MAX + ', reports ' + CHAT_RAPOR_MAX + ')');
