// =========================
// 🔥 SERVER FIX (server.js)
// =========================

function sendFullState(room){
  const payload = {
    type: "init",
    balls: room.balls,
    turn: room.turn,
    seed: room.seed
  };

  room.players.forEach(p=>{
    if(p.ws.readyState === 1){
      p.ws.send(JSON.stringify(payload));
    }
  });
}

// Oyuncular eşleşince
function onPlayersReady(room){
  sendFullState(room);

  // küçük gecikme (render için zaman tanı)
  setTimeout(()=>{
    startPhysicsLoop(room);
  }, 100);
}


// =========================
// 🔥 CLIENT FIX (HTML içine JS)
// =========================

let balls = [];
let turn = 0;

ws.onmessage = (msg)=>{
  const data = JSON.parse(msg.data);

  if(data.type === "init"){
    console.log("INIT RECEIVED", data);

    balls = data.balls || [];
    turn = data.turn;

    render(); // zorla çiz
  }

  if(data.type === "sync"){
    balls = data.balls;
    render();
  }
};


// =========================
// 🔥 SAFE RENDER
// =========================

function render(){
  if(!balls || balls.length === 0) return;

  ctx.clearRect(0,0,canvas.width,canvas.height);

  balls.forEach(b=>{
    if(b.sunk) return;

    ctx.beginPath();
    ctx.arc(b.x, b.y, 10, 0, Math.PI*2);
    ctx.fillStyle = "white";
    ctx.fill();
  });
}


// =========================
// 🔥 TEST COMMAND (MANUAL)
// =========================

// Konsolda çalıştır test için:
// ws.send(JSON.stringify({type:"debug_force_sync"}));


// =========================
// 🎯 EXPECTED RESULT
// =========================

// ✔ siyah ekran yok
// ✔ ilk frame toplar var
// ✔ iki oyuncuda aynı görüntü
// ✔ atış sonrası glitch yok
