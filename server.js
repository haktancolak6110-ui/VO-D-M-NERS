
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const WebSocket = require("ws");

const PORT = Number(process.env.PORT) || 3000;
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const DATA_FILE = path.join(DATA_DIR, "players.json");

fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(DATA_FILE)) {
  fs.writeFileSync(DATA_FILE, JSON.stringify({ accounts: {} }, null, 2));
}

function loadDatabase() {
  try {
    const db = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    if (!db.accounts || typeof db.accounts !== "object") {
      db.accounts = {};
    }
    return db;
  } catch {
    return { accounts: {} };
  }
}

let database = loadDatabase();
let saveQueued = false;

function saveDatabase() {
  if (saveQueued) return;
  saveQueued = true;

  setTimeout(() => {
    saveQueued = false;
    try {
      const temporary = DATA_FILE + ".tmp";
      fs.writeFileSync(temporary, JSON.stringify(database, null, 2));
      fs.renameSync(temporary, DATA_FILE);
    } catch (error) {
      console.error("Kayıt dosyası yazılamadı:", error.message);
    }
  }, 100);
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString("hex");
}

function createToken() {
  return crypto.randomBytes(32).toString("hex");
}

function makeId() {
  return crypto.randomBytes(12).toString("hex");
}

function randomBetween(min, max) {
  return Math.random() * (max - min) + min;
}

function newPlayer(username) {
  return {
    id: makeId(),
    username,
    x: randomBetween(-90, 90),
    y: randomBetween(-90, 90),
    angle: 0,
    credits: 0,
    ore: 0,
    totalMined: 0,
    level: 1,
    xp: 0,
    hp: 100,
    speedLevel: 1,
    miningLevel: 1,
    createdAt: Date.now()
  };
}

function publicPlayer(player) {
  return {
    id: player.id,
    username: player.username,
    x: player.x,
    y: player.y,
    angle: player.angle,
    credits: player.credits,
    ore: player.ore,
    totalMined: player.totalMined,
    level: player.level,
    xp: player.xp,
    hp: player.hp,
    speedLevel: player.speedLevel,
    miningLevel: player.miningLevel
  };
}

const world = {
  width: 6000,
  height: 6000,
  station: { x: 0, y: 0, radius: 155 },
  asteroids: [],
  nextAsteroidId: 1
};

function spawnAsteroid() {
  let x, y;

  do {
    x = randomBetween(-world.width / 2, world.width / 2);
    y = randomBetween(-world.height / 2, world.height / 2);
  } while (Math.hypot(x, y) < 260);

  const roll = Math.random();
  const type = roll < 0.68 ? "iron" : roll < 0.93 ? "gold" : "crystal";

  world.asteroids.push({
    id: world.nextAsteroidId++,
    x,
    y,
    radius: type === "crystal" ? 25 : randomBetween(19, 32),
    type,
    amount: type === "iron" ? 1 : type === "gold" ? 3 : 6,
    rotation: randomBetween(0, Math.PI * 2),
    spin: randomBetween(-0.5, 0.5)
  });
}

for (let i = 0; i < 180; i++) spawnAsteroid();

const sessions = new Map();
const socketSessions = new Map();
const chatHistory = [];

function send(ws, packet) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(packet));
  }
}

function reply(ws, id, ok, message, data) {
  send(ws, { type: "reply", id, ok, message, data });
}

function notice(session, text) {
  send(session.socket, { type: "notice", text });
}

function distanceToStation(player) {
  return Math.hypot(
    player.x - world.station.x,
    player.y - world.station.y
  );
}

function nearStation(player) {
  return distanceToStation(player) <= world.station.radius;
}

function xpNeeded(level) {
  return 100 + (level - 1) * 50;
}

function awardXP(player, amount) {
  player.xp += amount;

  while (player.xp >= xpNeeded(player.level)) {
    player.xp -= xpNeeded(player.level);
    player.level++;
    player.hp = 100;
  }
}

function getLeaderboard() {
  return [...sessions.values()]
    .map(s => ({
      username: s.player.username,
      level: s.player.level,
      score: s.player.credits + s.player.totalMined * 10
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);
}

function broadcast(packet) {
  for (const session of sessions.values()) {
    send(session.socket, packet);
  }
}

function broadcastChat(packet) {
  chatHistory.push(packet);
  if (chatHistory.length > 40) chatHistory.shift();
  broadcast({ type: "chat", ...packet });
}

function getState(session) {
  return {
    type: "state",
    me: publicPlayer(session.player),
    players: [...sessions.values()]
      .filter(s => s !== session)
      .map(s => publicPlayer(s.player)),
    asteroids: world.asteroids,
    leaderboard: getLeaderboard(),
    station: world.station,
    online: sessions.size,
    world: { width: world.width, height: world.height }
  };
}

function sendFullState(session) {
  send(session.socket, getState(session));
}

function attachPlayer(ws, account) {
  const p = account.player;

  const session = {
    socket: ws,
    player: p,
    account,
    keys: {},
    lastMine: 0,
    lastDamage: 0,
    lastState: 0
  };

  sessions.set(p.id, session);
  socketSessions.set(ws, session);

  send(ws, {
    type: "auth",
    ok: true,
    token: account.token,
    player: publicPlayer(p),
    message: "Hoş geldin, " + p.username + "!"
  });

  for (const oldMessage of chatHistory) {
    send(ws, { type: "chat", ...oldMessage });
  }

  broadcastChat({
    username: "SİSTEM",
    text: p.username + " uzay istasyonuna bağlandı.",
    time: Date.now()
  });

  sendFullState(session);
}

function authenticate(ws, message) {
  const action = String(message.action || "");
  const username = String(message.username || "").trim();
  const password = String(message.password || "");

  if (action === "resume") {
    const token = String(message.token || "");
    const account = Object.values(database.accounts).find(
      a => a.token === token
    );

    if (!account) {
      send(ws, {
        type: "auth",
        ok: false,
        message: "Oturum bulunamadı. Giriş yap veya hesap oluştur."
      });
      return;
    }

    attachPlayer(ws, account);
    return;
  }

  if (!/^[a-zA-Z0-9_]{3,16}$/.test(username)) {
    send(ws, {
      type: "auth",
      ok: false,
      message: "Kullanıcı adı 3-16 karakter olmalı. Harf, sayı ve _ kullan."
    });
    return;
  }

  if (password.length < 4 || password.length > 100) {
    send(ws, {
      type: "auth",
      ok: false,
      message: "Şifre en az 4 karakter olmalı."
    });
    return;
  }

  const key = username.toLowerCase();

  if (action === "register") {
    if (database.accounts[key]) {
      send(ws, {
        type: "auth",
        ok: false,
        message: "Bu kullanıcı adı zaten alınmış."
      });
      return;
    }

    const salt = crypto.randomBytes(16).toString("hex");
    const account = {
      username,
      salt,
      passwordHash: hashPassword(password, salt),
      token: createToken(),
      player: newPlayer(username)
    };

    database.accounts[key] = account;
    saveDatabase();
    attachPlayer(ws, account);
    return;
  }

  if (action === "login") {
    const account = database.accounts[key];

    if (
      !account ||
      hashPassword(password, account.salt) !== account.passwordHash
    ) {
      send(ws, {
        type: "auth",
        ok: false,
        message: "Kullanıcı adı veya şifre yanlış."
      });
      return;
    }

    // Eski oturum anahtarı her başarılı girişte yenilenir.
    account.token = createToken();
    saveDatabase();
    attachPlayer(ws, account);
    return;
  }

  send(ws, {
    type: "auth",
    ok: false,
    message: "Bilinmeyen giriş işlemi."
  });
}

function mine(session) {
  const player = session.player;
  const now = Date.now();
  const cooldown = Math.max(250, 900 - player.miningLevel * 90);

  if (now - session.lastMine < cooldown) return;
  session.lastMine = now;

  let target = null;
  let bestDistance = Infinity;

  for (const asteroid of world.asteroids) {
    const d = Math.hypot(asteroid.x - player.x, asteroid.y - player.y);
    if (d < asteroid.radius + 95 && d < bestDistance) {
      target = asteroid;
      bestDistance = d;
    }
  }

  if (!target) {
    notice(session, "Kazmak için yakında bir asteroit olmalı.");
    return;
  }

  const index = world.asteroids.findIndex(a => a.id === target.id);
  if (index < 0) return;

  world.asteroids.splice(index, 1);

  player.ore += target.amount;
  player.totalMined += target.amount;
  awardXP(player, target.amount * 8);

  const names = { iron: "Demir", gold: "Altın", crystal: "Kristal" };
  notice(
    session,
    names[target.type] + " asteroidi kazıldı! +" + target.amount + " cevher"
  );

  spawnAsteroid();
  saveDatabase();
}

function sellOre(session, requestId) {
  const player = session.player;

  if (!nearStation(player)) {
    reply(
      session.socket,
      requestId,
      false,
      "Satış için istasyona yaklaşmalısın."
    );
    return;
  }

  if (player.ore <= 0) {
    reply(session.socket, requestId, false, "Satacak cevherin yok.");
    return;
  }

  const amount = player.ore;
  const earned = amount * 10;

  player.ore = 0;
  player.credits += earned;
  awardXP(player, amount * 2);

  saveDatabase();

  reply(
    session.socket,
    requestId,
    true,
    amount + " cevher " + earned + " krediye satıldı.",
    { player: publicPlayer(player) }
  );
}

function buyUpgrade(session, message) {
  const player = session.player;

  if (!nearStation(player)) {
    reply(session.socket, message.id, false, "Yükseltme için istasyona yaklaş.");
    return;
  }

  const item = String(message.item || "");
  const isSpeed = item === "speed";
  const isMining = item === "mining";

  if (!isSpeed && !isMining) {
    reply(session.socket, message.id, false, "Geçersiz yükseltme.");
    return;
  }

  const levelKey = isSpeed ? "speedLevel" : "miningLevel";
  const currentLevel = player[levelKey];
  const price = currentLevel * 150;

  if (currentLevel >= 10) {
    reply(session.socket, message.id, false, "Bu yükseltme maksimum seviyede.");
    return;
  }

  if (player.credits < price) {
    reply(
      session.socket,
      message.id,
      false,
      "Yetersiz kredi. Gerekli: " + price
    );
    return;
  }

  player.credits -= price;
  player[levelKey]++;
  saveDatabase();

  reply(
    session.socket,
    message.id,
    true,
    (isSpeed ? "Motor" : "Madencilik lazeri") + " yükseltildi!",
    { player: publicPlayer(player) }
  );
}

function processMessage(ws, message) {
  const session = socketSessions.get(ws);

  if (message.type === "auth") {
    if (!session) authenticate(ws, message);
    return;
  }

  if (!session) return;

  const player = session.player;

  switch (message.type) {
    case "input": {
      const keys = message.keys || {};
      session.keys = {
        up: !!keys.up,
        down: !!keys.down,
        left: !!keys.left,
        right: !!keys.right
      };
      if (typeof keys.angle === "number" && Number.isFinite(keys.angle)) {
        player.angle = keys.angle;
      }
      if (keys.mine) mine(session);
      break;
    }

    case "mine":
      mine(session);
      break;

    case "chat": {
      const text = String(message.text || "").trim().slice(0, 180);
      if (!text) break;

      broadcastChat({
        username: player.username,
        text,
        time: Date.now()
      });
      break;
    }

    case "sell":
      sellOre(session, message.id);
      break;

    case "buy":
      buyUpgrade(session, message);
      break;

    case "station":
      reply(
        ws,
        message.id,
        nearStation(player),
        nearStation(player)
          ? "İstasyona hoş geldin."
          : "İstasyon çok uzakta. Haritanın merkezine, (0, 0) noktasına git.",
        { player: publicPlayer(player) }
      );
      break;

    case "ping":
      send(ws, { type: "pong", time: Date.now() });
      break;
  }
}

const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, "http://localhost").pathname;

  if (pathname === "/" || pathname === "/index.html") {
    const file = path.join(ROOT, "index.html");

    fs.readFile(file, (error, content) => {
      if (error) {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("index.html okunamadı.");
        return;
      }

      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-cache"
      });
      res.end(content);
    });

    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Sayfa bulunamadı.");
});

const wss = new WebSocket.Server({ server });

wss.on("connection", ws => {
  ws.isAlive = true;

  ws.on("pong", () => {
    ws.isAlive = true;
  });

  ws.on("message", raw => {
    try {
      const message = JSON.parse(raw.toString());
      processMessage(ws, message);
    } catch (error) {
      console.error("Mesaj işlenemedi:", error.message);
      send(ws, { type: "error", message: "Geçersiz sunucu mesajı." });
    }
  });

  ws.on("close", () => {
    const session = socketSessions.get(ws);
    if (!session) return;

    sessions.delete(session.player.id);
    socketSessions.delete(ws);

    broadcastChat({
      username: "SİSTEM",
      text: session.player.username + " bağlantıyı kesti.",
      time: Date.now()
    });

    saveDatabase();
  });

  ws.on("error", error => {
    console.error("WebSocket hatası:", error.message);
  });
});

const TICK_RATE = 30;
const TICK_MS = 1000 / TICK_RATE;

setInterval(() => {
  const dt = 1 / TICK_RATE;

  for (const session of sessions.values()) {
    const p = session.player;
    const keys = session.keys;

    let dx = 0;
    let dy = 0;

    if (keys.up) dy -= 1;
    if (keys.down) dy += 1;
    if (keys.left) dx -= 1;
    if (keys.right) dx += 1;

    if (dx !== 0 || dy !== 0) {
      const length = Math.hypot(dx, dy);
      dx /= length;
      dy /= length;

      const speed = 210 + (p.speedLevel - 1) * 24;

      p.x += dx * speed * dt;
      p.y += dy * speed * dt;
      p.angle = Math.atan2(dy, dx);

      p.x = Math.max(-world.width / 2, Math.min(world.width / 2, p.x));
      p.y = Math.max(-world.height / 2, Math.min(world.height / 2, p.y));
    }

    // İstasyonda gemi yavaşça onarılır.
    if (nearStation(p) && p.hp < 100) {
      p.hp = Math.min(100, p.hp + 4 * dt);
    }
  }

  const now = Date.now();

  for (const session of sessions.values()) {
    if (now - session.lastState >= 100) {
      session.lastState = now;
      send(session.socket, getState(session));
    }
  }
}, TICK_MS);

setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

setInterval(saveDatabase, 30000);

server.listen(PORT, "0.0.0.0", () => {
  console.log("");
  console.log("==================================");
  console.log("  VOID MINERS sunucusu çalışıyor!");
  console.log("  http://localhost:" + PORT);
  console.log("==================================");
  console.log("");
});


