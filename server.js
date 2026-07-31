'use strict';

/**
 * "Вместе" — signaling-сервер.
 *
 * Что он делает: НЕ передаёт видео и звук. Он только знакомит браузеры
 * друг с другом, а дальше они общаются напрямую (WebRTC P2P).
 * Поэтому сервер почти ничего не стоит — тяжёлый трафик идёт мимо него.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const MAX_PEERS_PER_ROOM = 8; // mesh-топология: больше — начнёт тормозить

// Локально файлы лежат в папке public/. Но если код залит на GitHub через
// веб-интерфейс, папки теряются и всё оказывается в корне — поддерживаем оба случая.
const PUBLIC_DIR = fs.existsSync(path.join(__dirname, 'public', 'index.html'))
  ? path.join(__dirname, 'public')
  : __dirname;

// Исходники наружу не отдаём — только то, что нужно браузеру.
const NEVER_SERVE = new Set([
  'server.js', 'package.json', 'package-lock.json', 'render.yaml',
  '.gitignore', 'readme.md', 'план.md'
]);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

// ---------- Ретранслятор (TURN) ----------
// Ключи живут в переменных окружения на сервере и НИКОГДА не попадают в браузер.
// Клиенту отдаём только короткоживущие логин-пароль, которые Cloudflare выдаёт на сутки.

const TURN_KEY_ID = process.env.TURN_KEY_ID || '';
const TURN_KEY_API_TOKEN = process.env.TURN_KEY_API_TOKEN || '';

// Запасной вариант, если ключи ещё не прописаны: публичные серверы.
// Работают через раз, но лучше, чем ничего.
const FALLBACK_ICE = [
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun.nextcloud.com:443' },
  {
    urls: ['turn:openrelay.metered.ca:80', 'turn:openrelay.metered.ca:443', 'turn:openrelay.metered.ca:443?transport=tcp'],
    username: 'openrelayproject',
    credential: 'openrelayproject'
  }
];

let iceCache = { at: 0, servers: null };

async function getIceServers() {
  if (!TURN_KEY_ID || !TURN_KEY_API_TOKEN) return { servers: FALLBACK_ICE, source: 'public' };

  // Ходим к Cloudflare не чаще раза в час — выданных данных хватает на сутки.
  if (iceCache.servers && Date.now() - iceCache.at < 60 * 60 * 1000) {
    return { servers: iceCache.servers, source: 'cloudflare' };
  }

  try {
    const r = await fetch(
      'https://rtc.live.cloudflare.com/v1/turn/keys/' + TURN_KEY_ID + '/credentials/generate-ice-servers',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + TURN_KEY_API_TOKEN,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ ttl: 86400 })
      }
    );
    if (!r.ok) throw new Error('Cloudflare ответил ' + r.status);
    const data = await r.json();
    const list = Array.isArray(data.iceServers) ? data.iceServers : [data.iceServers];
    // К ретранслятору добавляем STUN — прямая связь всегда быстрее и дешевле
    const servers = [{ urls: 'stun:stun.cloudflare.com:3478' }].concat(list.filter(Boolean));
    iceCache = { at: Date.now(), servers };
    return { servers, source: 'cloudflare' };
  } catch (e) {
    console.error('TURN: не удалось получить данные Cloudflare —', e.message);
    return { servers: FALLBACK_ICE, source: 'public' };
  }
}

// ---------- HTTP: отдаём статику ----------

const server = http.createServer((req, res) => {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400).end('Bad request');
    return;
  }

  // Данные для связи запрашивает браузер перед входом в комнату
  if (urlPath === '/ice') {
    getIceServers().then(({ servers, source }) => {
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store'
      });
      res.end(JSON.stringify({ iceServers: servers, source }));
    });
    return;
  }

  // Любой путь вида /r/abc отдаёт то же приложение
  if (urlPath === '/' || urlPath.startsWith('/r/')) urlPath = '/index.html';

  const filePath = path.join(PUBLIC_DIR, urlPath);
  const base = path.basename(filePath).toLowerCase();

  // защита от выхода за пределы папки и от раздачи исходников
  if (!filePath.startsWith(PUBLIC_DIR) || NEVER_SERVE.has(base) || base.endsWith('.bat')) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Не найдено');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
});

// ---------- WebSocket: сигналинг ----------

const wss = new WebSocketServer({ server });
const rooms = new Map(); // roomId -> Map(peerId -> { ws, name })

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

// Аватар — это НЕ персональные данные: просто картинка-значок и цвет,
// которые человек выбрал сам. Ничего идентифицирующего мы не храним.
const DEFAULT_AVATAR = { emoji: '🙂', color: '#5b8cff' };

function cleanAvatar(a) {
  if (!a || typeof a !== 'object') return DEFAULT_AVATAR;
  const emoji = typeof a.emoji === 'string' ? [...a.emoji].slice(0, 2).join('') : '';
  const color = typeof a.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(a.color) ? a.color : DEFAULT_AVATAR.color;
  const out = { emoji: emoji || DEFAULT_AVATAR.emoji, color };

  // Фотография профиля. Живёт только в памяти, пока человек в комнате,
  // на диск не пишется. Ограничиваем размер, чтобы никто не завалил сервер.
  if (typeof a.img === 'string' && /^data:image\/(png|jpeg|webp);base64,/.test(a.img) && a.img.length <= 40000) {
    out.img = a.img;
  }
  return out;
}

function broadcast(roomId, obj, exceptId) {
  const room = rooms.get(roomId);
  if (!room) return;
  for (const [id, peer] of room) {
    if (id !== exceptId) send(peer.ws, obj);
  }
}

function leaveRoom(ws) {
  const meta = ws.meta;
  if (!meta) return;
  ws.meta = null;
  const room = rooms.get(meta.roomId);
  if (!room) return;
  room.delete(meta.peerId);
  if (room.size === 0) rooms.delete(meta.roomId);
  else broadcast(meta.roomId, { type: 'peer-left', id: meta.peerId });
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.meta = null;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.type === 'join') {
      leaveRoom(ws);

      const roomId = String(msg.room || '').trim().slice(0, 64) || 'lobby';
      const name = String(msg.name || 'Гость').trim().slice(0, 32) || 'Гость';
      const avatar = cleanAvatar(msg.avatar);
      const peerId = crypto.randomUUID();

      if (!rooms.has(roomId)) rooms.set(roomId, new Map());
      const room = rooms.get(roomId);

      if (room.size >= MAX_PEERS_PER_ROOM) {
        send(ws, { type: 'error', message: 'В комнате уже максимум участников (' + MAX_PEERS_PER_ROOM + ').' });
        return;
      }

      const peers = [...room].map(([id, p]) => ({ id: id, name: p.name, avatar: p.avatar }));
      room.set(peerId, { ws, name, avatar });
      ws.meta = { roomId, peerId, name, avatar };

      send(ws, { type: 'joined', id: peerId, room: roomId, peers });
      broadcast(roomId, { type: 'peer-joined', id: peerId, name, avatar }, peerId);
      return;
    }

    if (!ws.meta) return;
    const { roomId, peerId, name, avatar } = ws.meta;
    const room = rooms.get(roomId);
    if (!room) return;

    if (msg.type === 'signal') {
      const target = room.get(msg.to);
      if (target) send(target.ws, { type: 'signal', from: peerId, data: msg.data });
      return;
    }

    // Синхронный просмотр: пауза, запуск и перемотка у всех одновременно.
    // Сам фильм через сервер НЕ идёт — только команды плееру.
    if (msg.type === 'sync') {
      const action = ['play', 'pause', 'seek', 'ready'].includes(msg.action) ? msg.action : null;
      if (!action) return;
      const time = Number.isFinite(msg.time) ? Math.max(0, Math.min(msg.time, 86400)) : 0;
      const title = typeof msg.title === 'string' ? msg.title.slice(0, 120) : '';
      broadcast(roomId, { type: 'sync', from: peerId, name, action, time, title }, peerId);
      return;
    }

    if (msg.type === 'chat') {
      const text = String(msg.text || '').slice(0, 500);
      // отправителю не шлём — он уже показал своё сообщение у себя
      if (text) broadcast(roomId, { type: 'chat', from: peerId, name, avatar, text, at: Date.now() }, peerId);
      return;
    }
  });

  ws.on('close', () => leaveRoom(ws));
  ws.on('error', () => leaveRoom(ws));
});

// Держим соединения живыми (бесплатные хостинги рвут idle-сокеты)
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

wss.on('close', () => clearInterval(heartbeat));

server.listen(PORT, () => {
  console.log('Вместе — сервер запущен: http://localhost:' + PORT);
});
