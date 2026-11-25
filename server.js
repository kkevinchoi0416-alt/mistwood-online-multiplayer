'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const EventEmitter = require('events');

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 3000);
const MAX_PLAYERS = 8;
const TICK_MS = 1000 / 30;
const SNAPSHOT_EVERY = 2;
const TRACK_RX = 180;
const TRACK_RZ = 260;
const VIP_PIN = process.env.VIP_PIN || 'sindorim!';
const ADMIN_PIN = process.env.ADMIN_PIN || '0011';

// 차량 선택과 주행 능력은 별도 JSON 파일을 사용합니다.
const VEHICLES = JSON.parse(fs.readFileSync(path.join(ROOT, 'vehicles.json'), 'utf8'));
const VEHICLE_MAP = new Map(VEHICLES.map(v => [v.id, v]));
const VIP_IDS = new Set(['eventCrusher', 'speedster', 'eventTank', 'forestBike', 'teslaRoadster', 'vipRevuelto']);

const rooms = new Map();
const sockets = new Set();
let tickCount = 0;

function safeSend(ws, payload) {
  if (ws.readyState === 1) ws.send(JSON.stringify(payload));
}
function sanitizeName(value) {
  const name = String(value || '').replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, 14);
  return name || `Driver-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
}
function makeRoomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 5 }, () => alphabet[crypto.randomInt(alphabet.length)]).join('');
  } while (rooms.has(code));
  return code;
}
function roomPlayers(room) {
  return [...room.players.values()].map(p => ({
    id: p.id, name: p.name, vehicleId: p.vehicleId,
    host: p.id === room.hostId, admin: p.adminUnlocked, vip: p.vipUnlocked,
    x: p.x, z: p.z, yaw: p.yaw, speed: p.speed,
    boostRemaining: Math.max(0, p.boostUntil - Date.now()) / 1000,
    abilityCooldown: Math.max(0, p.abilityReadyAt - Date.now()) / 1000
  }));
}
function sendRoomState(room) {
  const payload = {
    type: 'room-state', roomCode: room.code, hostId: room.hostId,
    started: room.started, players: roomPlayers(room), maxPlayers: MAX_PLAYERS
  };
  for (const p of room.players.values()) safeSend(p.ws, payload);
}
function sendError(ws, message) { safeSend(ws, { type: 'error', message }); }
function hasAccess(ws, vehicle) {
  if (vehicle.adminOnly && !ws.adminUnlocked) return false;
  if (VIP_IDS.has(vehicle.id) && !ws.vipUnlocked) return false;
  return true;
}
function pinMatches(input, expected) {
  const a = Buffer.from(String(input || ''));
  const b = Buffer.from(String(expected));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function spawnPlayer(player, index, count) {
  const lane = (index - (count - 1) / 2) * 4.2;
  player.x = lane;
  player.z = -TRACK_RZ;
  player.yaw = Math.PI / 2;
  player.speed = 0;
  player.controls = { forward: false, reverse: false, left: false, right: false, brake: false };
  player.boostUntil = 0;
  player.abilityReadyAt = 0;
}
function canUseBoost(player, now) {
  const vehicle = VEHICLE_MAP.get(player.vehicleId);
  if (!vehicle || now < player.abilityReadyAt) return false;
  if (vehicle.motorcycle) {
    player.boostUntil = now + 2000;
    player.abilityReadyAt = now + 10000;
    return true;
  }
  if (vehicle.vipOverboost) {
    player.boostUntil = now + 4000;
    player.abilityReadyAt = now + 18000;
    return true;
  }
  if (vehicle.fast || vehicle.adminOnly) {
    player.boostUntil = now + 3000;
    player.abilityReadyAt = now + 12000;
    return true;
  }
  return false;
}
function publicVehicleUpdate(room, player) {
  for (const other of room.players.values()) {
    if (other.id !== player.id) safeSend(other.ws, { type: 'player-vehicle', playerId: player.id, vehicleId: player.vehicleId });
  }
  sendRoomState(room);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(JSON.stringify({ ok: true, rooms: rooms.size, onlinePlayers: sockets.size }));
  }
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';
  // 공개 서버는 게임 화면만 제공합니다. server.js와 환경 설정 파일은 다운로드할 수 없습니다.
  if (pathname !== '/index.html') {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('Not found');
  }
  const target = path.join(ROOT, 'index.html');
  fs.readFile(target, (err, data) => {
    if (err) { res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('Game page could not be loaded'); }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
    res.end(data);
  });
});

// Node.js 기본 기능만으로 처리하는 작은 WebSocket 서버입니다.
// 별도 npm 패키지가 필요 없어 설치 과정이 간단합니다.
class PeerSocket extends EventEmitter {
  constructor(socket, head = Buffer.alloc(0)) {
    super();
    this.socket = socket;
    this.readyState = 1;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.fragmentOpcode = 0;
    socket.on('data', data => this._onData(data));
    socket.on('error', err => this.emit('error', err));
    socket.on('close', () => { this.readyState = 3; this.emit('close'); });
    if (head.length) this._onData(head);
  }
  send(text) {
    if (this.readyState !== 1) return;
    const payload = Buffer.from(String(text));
    let header;
    if (payload.length < 126) {
      header = Buffer.from([0x81, payload.length]);
    } else if (payload.length <= 0xffff) {
      header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126; header.writeUInt16BE(payload.length, 2);
    } else {
      header = Buffer.alloc(10); header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(payload.length), 2);
    }
    this.socket.write(Buffer.concat([header, payload]));
  }
  close() {
    if (this.readyState !== 1) return;
    this.readyState = 2;
    try { this.socket.write(Buffer.from([0x88, 0x00])); } catch {}
    this.socket.end();
  }
  _onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 2) {
      const b0 = this.buffer[0], b1 = this.buffer[1];
      const fin = (b0 & 0x80) !== 0, opcode = b0 & 0x0f, masked = (b1 & 0x80) !== 0;
      let length = b1 & 0x7f, offset = 2;
      if (length === 126) { if (this.buffer.length < 4) return; length = this.buffer.readUInt16BE(2); offset = 4; }
      else if (length === 127) { if (this.buffer.length < 10) return; const wide = this.buffer.readBigUInt64BE(2); if (wide > 65536n) return this.close(); length = Number(wide); offset = 10; }
      if (length > 65536) return this.close();
      let mask;
      if (masked) { if (this.buffer.length < offset + 4) return; mask = this.buffer.subarray(offset, offset + 4); offset += 4; }
      if (this.buffer.length < offset + length) return;
      let payload = Buffer.from(this.buffer.subarray(offset, offset + length));
      this.buffer = this.buffer.subarray(offset + length);
      if (masked) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      if (opcode === 0x8) { this.close(); return; }
      if (opcode === 0x9) { this._sendControl(0xA, payload); continue; }
      if (opcode === 0xA) continue;
      if (opcode === 0x1 || opcode === 0x2) {
        if (fin) this.emit('message', payload);
        else { this.fragments = [payload]; this.fragmentOpcode = opcode; }
      } else if (opcode === 0x0 && this.fragments.length) {
        this.fragments.push(payload);
        if (fin) { const complete = Buffer.concat(this.fragments); this.fragments = []; this.emit('message', complete); }
      }
    }
  }
  _sendControl(opcode, payload) {
    if (this.readyState !== 1) return;
    const head = Buffer.from([0x80 | opcode, payload.length]);
    this.socket.write(Buffer.concat([head, payload]));
  }
}

server.on('upgrade', (req, socket, head) => {
  const key = req.headers['sec-websocket-key'];
  if (String(req.headers.upgrade || '').toLowerCase() !== 'websocket' || !key) { socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
  const ws = new PeerSocket(socket, head);
  handleConnection(ws);
});

function handleConnection(ws) {
  sockets.add(ws);
  ws.room = null;
  ws.player = null;
  ws.adminUnlocked = false;
  ws.vipUnlocked = false;
  ws.pinFailures = 0;
  ws.pinLockedUntil = 0;
  safeSend(ws, { type: 'connected', message: '온라인 서버에 연결되었습니다.' });

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return sendError(ws, '잘못된 메시지 형식입니다.'); }
    if (!msg || typeof msg.type !== 'string') return;

    if (msg.type === 'unlock') {
      const now = Date.now();
      if (now < ws.pinLockedUntil) return safeSend(ws, { type: 'unlock-result', ok: false, role: msg.role, message: '인증 시도가 잠시 잠겼습니다. 2분 뒤 다시 시도해 주세요.' });
      const role = msg.role === 'admin' ? 'admin' : msg.role === 'vip' ? 'vip' : null;
      if (!role) return sendError(ws, '알 수 없는 잠금 종류입니다.');
      const expected = role === 'admin' ? ADMIN_PIN : VIP_PIN;
      const ok = pinMatches(msg.pin, expected);
      if (!ok) {
        ws.pinFailures++;
        if (ws.pinFailures >= 5) { ws.pinLockedUntil = now + 120000; ws.pinFailures = 0; }
        return safeSend(ws, { type: 'unlock-result', ok: false, role, message: '비밀번호가 맞지 않습니다.' });
      }
      if (role === 'admin') ws.adminUnlocked = true;
      else ws.vipUnlocked = true;
      ws.pinFailures = 0;
      safeSend(ws, { type: 'unlock-result', ok: true, role, message: role === 'admin' ? '관리자 차량이 해금되었습니다.' : 'VIP 차량이 해금되었습니다.' });
      if (ws.player) {
        ws.player.adminUnlocked = ws.adminUnlocked;
        ws.player.vipUnlocked = ws.vipUnlocked;
        sendRoomState(ws.room);
      }
      return;
    }

    if (msg.type === 'create-room') {
      if (ws.player) return sendError(ws, '이미 방에 참가 중입니다.');
      const name = sanitizeName(msg.name);
      const vehicle = VEHICLE_MAP.get(String(msg.vehicleId || 'grandeur')) || VEHICLES[0];
      if (!hasAccess(ws, vehicle)) return sendError(ws, '선택한 차량의 잠금이 해제되지 않았습니다.');
      const code = makeRoomCode();
      const player = makePlayer(ws, name, vehicle.id);
      const room = { code, hostId: player.id, started: false, players: new Map() };
      room.players.set(player.id, player);
      rooms.set(code, room);
      ws.room = room; ws.player = player;
      safeSend(ws, { type: 'room-created', roomCode: code, playerId: player.id });
      sendRoomState(room);
      return;
    }

    if (msg.type === 'join-room') {
      if (ws.player) return sendError(ws, '이미 방에 참가 중입니다.');
      const code = String(msg.roomCode || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
      const room = rooms.get(code);
      if (!room) return sendError(ws, '방을 찾을 수 없습니다. 방 코드를 다시 확인해 주세요.');
      if (room.started) return sendError(ws, '이미 게임이 시작된 방입니다.');
      if (room.players.size >= MAX_PLAYERS) return sendError(ws, `방이 가득 찼습니다. 최대 ${MAX_PLAYERS}명까지 참가할 수 있습니다.`);
      const name = sanitizeName(msg.name);
      const vehicle = VEHICLE_MAP.get(String(msg.vehicleId || 'grandeur')) || VEHICLES[0];
      if (!hasAccess(ws, vehicle)) return sendError(ws, '선택한 차량의 잠금이 해제되지 않았습니다.');
      const player = makePlayer(ws, name, vehicle.id);
      room.players.set(player.id, player);
      ws.room = room; ws.player = player;
      safeSend(ws, { type: 'room-joined', roomCode: code, playerId: player.id });
      sendRoomState(room);
      return;
    }

    if (msg.type === 'select-vehicle') {
      if (!ws.player || !ws.room) return sendError(ws, '먼저 온라인 방에 참가해 주세요.');
      if (ws.room.started) return sendError(ws, '게임이 진행 중일 때는 차량을 바꿀 수 없습니다.');
      const vehicle = VEHICLE_MAP.get(String(msg.vehicleId || ''));
      if (!vehicle) return sendError(ws, '존재하지 않는 차량입니다.');
      if (!hasAccess(ws, vehicle)) return sendError(ws, '이 차량은 VIP 또는 관리자 전용입니다.');
      ws.player.vehicleId = vehicle.id;
      publicVehicleUpdate(ws.room, ws.player);
      return;
    }

    if (msg.type === 'start-room') {
      if (!ws.player || !ws.room) return sendError(ws, '온라인 방에 참가해 주세요.');
      if (ws.room.hostId !== ws.player.id) return sendError(ws, '방장만 게임을 시작할 수 있습니다.');
      if (ws.room.started) return;
      ws.room.started = true;
      const players = [...ws.room.players.values()];
      players.forEach((p, i) => spawnPlayer(p, i, players.length));
      sendRoomState(ws.room);
      return;
    }

    if (msg.type === 'stop-room') {
      if (!ws.player || !ws.room || ws.room.hostId !== ws.player.id) return sendError(ws, '방장만 대기실로 돌아갈 수 있습니다.');
      ws.room.started = false;
      for (const p of ws.room.players.values()) {
        p.speed = 0;
        p.controls = { forward: false, reverse: false, left: false, right: false, brake: false };
      }
      sendRoomState(ws.room);
      return;
    }

    if (msg.type === 'input') {
      if (!ws.player || !ws.room || !ws.room.started) return;
      const c = msg.controls || {};
      ws.player.controls = {
        forward: !!c.forward, reverse: !!c.reverse,
        left: !!c.left, right: !!c.right, brake: !!c.brake
      };
      return;
    }

    if (msg.type === 'ability') {
      if (!ws.player || !ws.room || !ws.room.started) return;
      const now = Date.now();
      const ok = canUseBoost(ws.player, now);
      safeSend(ws, { type: 'ability-result', ok, boostRemaining: Math.max(0, ws.player.boostUntil - now) / 1000, cooldown: Math.max(0, ws.player.abilityReadyAt - now) / 1000, message: ok ? '부스트 발동!' : '이 차량은 부스트를 사용할 수 없거나 재사용 대기 중입니다.' });
      return;
    }

    if (msg.type === 'leave-room') {
      leaveRoom(ws);
      safeSend(ws, { type: 'left-room' });
      return;
    }
  });

  ws.on('close', () => { sockets.delete(ws); leaveRoom(ws); });
  ws.on('error', () => { sockets.delete(ws); leaveRoom(ws); });
}

function makePlayer(ws, name, vehicleId) {
  return {
    id: crypto.randomUUID(), ws, name, vehicleId,
    adminUnlocked: ws.adminUnlocked, vipUnlocked: ws.vipUnlocked,
    x: 0, z: -TRACK_RZ, yaw: Math.PI / 2, speed: 0,
    controls: { forward: false, reverse: false, left: false, right: false, brake: false },
    boostUntil: 0, abilityReadyAt: 0
  };
}
function leaveRoom(ws) {
  const room = ws.room;
  const player = ws.player;
  if (!room || !player) { ws.room = null; ws.player = null; return; }
  room.players.delete(player.id);
  ws.room = null; ws.player = null;
  if (room.players.size === 0) { rooms.delete(room.code); return; }
  if (room.hostId === player.id) room.hostId = room.players.keys().next().value;
  sendRoomState(room);
}

let lastTick = Date.now();
setInterval(() => {
  const now = Date.now();
  const dt = Math.min(0.06, Math.max(0.005, (now - lastTick) / 1000));
  lastTick = now;
  tickCount++;
  for (const room of rooms.values()) {
    if (!room.started) continue;
    for (const p of room.players.values()) {
      const vehicle = VEHICLE_MAP.get(p.vehicleId) || VEHICLES[0];
      const c = p.controls;
      const boost = now < p.boostUntil;
      const boostMax = boost ? (vehicle.vipOverboost ? 1.22 : 1.18) : 1;
      const boostAccel = boost ? (vehicle.vipOverboost ? 1.52 : 1.65) : 1;
      const maxSpeed = Number(vehicle.maxSpeed) * boostMax;
      const accel = Number(vehicle.acceleration) * 0.82 * boostAccel;
      const brake = Number(vehicle.brake) || 24;
      const reverse = Number(vehicle.reverse) || 7;
      if (c.forward) p.speed = Math.min(maxSpeed, p.speed + accel * dt);
      if (c.reverse) {
        if (p.speed > 0.8) p.speed = Math.max(0, p.speed - brake * dt);
        else p.speed = Math.max(-reverse, p.speed - accel * 0.48 * dt);
      }
      if (c.brake) p.speed = p.speed > 0 ? Math.max(0, p.speed - brake * 1.4 * dt) : Math.min(0, p.speed + brake * 1.4 * dt);
      if (!c.forward && !c.reverse && !c.brake) p.speed *= Math.exp(-0.42 * dt);
      if (Math.abs(p.speed) < 0.035 && !c.forward && !c.reverse) p.speed = 0;
      const steer = (Number(vehicle.steering) || 1.3) * 0.30 * (0.23 + Math.min(1, Math.abs(p.speed) / Math.max(1, maxSpeed)) * 0.77);
      const direction = p.speed >= 0 ? 1 : -1;
      if (c.left) p.yaw -= steer * direction * dt;
      if (c.right) p.yaw += steer * direction * dt;
      p.x += Math.sin(p.yaw) * p.speed * dt;
      p.z -= Math.cos(p.yaw) * p.speed * dt;
      const oval = Math.sqrt((p.x * p.x) / (TRACK_RX * TRACK_RX) + (p.z * p.z) / (TRACK_RZ * TRACK_RZ));
      if (oval < 0.875 || oval > 1.13) p.speed *= Math.exp(-0.72 * dt);
      p.x = Math.max(-420, Math.min(420, p.x));
      p.z = Math.max(-520, Math.min(520, p.z));
    }
    if (tickCount % SNAPSHOT_EVERY === 0) {
      const payload = { type: 'snapshot', roomCode: room.code, players: roomPlayers(room), serverTime: now };
      for (const p of room.players.values()) safeSend(p.ws, payload);
    }
  }
}, TICK_MS);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`MISTWOOD Online server listening on port ${PORT}`);
});
