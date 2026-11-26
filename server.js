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
const SNAPSHOT_EVERY = 1;
// 차량과 10개 트랙은 JSON 파일로 분리해 학생이 쉽게 수정할 수 있습니다.
const VEHICLES = JSON.parse(fs.readFileSync(path.join(ROOT, 'vehicles.json'), 'utf8'));
const VEHICLE_MAP = new Map(VEHICLES.map(v => [v.id, v]));

// 차량 모델의 길이·너비(게임 단위). 차량 scale을 곱해 충돌 박스 크기를 맞춥니다.
function getVehicleHitbox(player) {
  const vehicle = VEHICLE_MAP.get(player.vehicleId) || VEHICLES[0];
  const scale = clamp(vehicle.scale, 0.75, 1.5, 1);
  const length = clamp(vehicle.collisionLength, 3.0, 8.0, 5.0) * scale;
  const width = clamp(vehicle.collisionWidth, 1.0, 3.5, 2.0) * scale;
  // 실제 외형보다 약간 안쪽으로 잡아 바퀴만 스쳐도 충돌하는 과민 판정을 줄입니다.
  return { halfLength: length * 0.48, halfWidth: width * 0.48 }; // 외형의 약 96% 범위로 판정합니다.
}
function vehicleAxes(yaw) {
  return {
    forward: { x: -Math.sin(yaw), z: -Math.cos(yaw) },
    right: { x: Math.cos(yaw), z: -Math.sin(yaw) }
  };
}
function orientedBoxContact(a, b) {
  const A = getVehicleHitbox(a), B = getVehicleHitbox(b);
  const aa = vehicleAxes(a.yaw), bb = vehicleAxes(b.yaw);
  const dx = b.x - a.x, dz = b.z - a.z;
  const axes = [aa.forward, aa.right, bb.forward, bb.right];
  let minOverlap = Infinity, bestAxis = null, bestSign = 1;
  for (const axis of axes) {
    const distance = dx * axis.x + dz * axis.z;
    const radiusA = A.halfLength * Math.abs(aa.forward.x * axis.x + aa.forward.z * axis.z)
      + A.halfWidth * Math.abs(aa.right.x * axis.x + aa.right.z * axis.z);
    const radiusB = B.halfLength * Math.abs(bb.forward.x * axis.x + bb.forward.z * axis.z)
      + B.halfWidth * Math.abs(bb.right.x * axis.x + bb.right.z * axis.z);
    const overlap = radiusA + radiusB - Math.abs(distance);
    // 4cm 미만의 모서리 접촉은 부동소수점 흔들림으로 보고 충돌에서 제외합니다.
    if (overlap <= 0.04) return null;
    if (overlap < minOverlap) {
      minOverlap = overlap;
      bestAxis = axis;
      bestSign = distance >= 0 ? 1 : -1;
    }
  }
  if (!bestAxis) return null;
  return { overlap: minOverlap, nx: bestAxis.x * bestSign, nz: bestAxis.z * bestSign };
}
const TRACKS = JSON.parse(fs.readFileSync(path.join(ROOT, 'tracks.json'), 'utf8'));
const TRACK_MAP = new Map(TRACKS.map(t => [t.id, t]));
const DEFAULT_MAP_ID = TRACKS[0].id;
const TRACK_STEPS = 12;

// 튜닝 범위는 서버에서 다시 검사해 비정상적으로 큰 값을 막습니다.
const DEFAULT_TUNE = Object.freeze({ topSpeed: 32, acceleration: 12.5, steering: 1.55, brake: 27, grip: 1, reverse: 8, coastDrag: 0.62 });
function clamp(value, min, max, fallback) { const n = Number(value); return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback; }
function sanitizeTune(input = {}) {
  return {
    topSpeed: clamp(input.topSpeed, 24, 42, DEFAULT_TUNE.topSpeed),
    acceleration: clamp(input.acceleration, 7, 18, DEFAULT_TUNE.acceleration),
    steering: clamp(input.steering, 0.8, 2.4, DEFAULT_TUNE.steering),
    brake: clamp(input.brake, 18, 36, DEFAULT_TUNE.brake),
    grip: clamp(input.grip, 0.75, 1.3, DEFAULT_TUNE.grip),
    reverse: clamp(input.reverse, 4, 12, DEFAULT_TUNE.reverse),
    coastDrag: clamp(input.coastDrag, 0.3, 0.95, DEFAULT_TUNE.coastDrag)
  };
}

// Catmull-Rom 곡선으로 웨이포인트 사이를 부드럽게 연결합니다.
function sampleTrack(track) {
  const points = track.points; const result = [];
  const count = points.length;
  for (let i = 0; i < count; i++) {
    const p0 = points[(i - 1 + count) % count], p1 = points[i], p2 = points[(i + 1) % count], p3 = points[(i + 2) % count];
    for (let step = 0; step < TRACK_STEPS; step++) {
      const t = step / TRACK_STEPS, t2 = t * t, t3 = t2 * t;
      const x = 0.5 * ((2*p1[0]) + (-p0[0]+p2[0])*t + (2*p0[0]-5*p1[0]+4*p2[0]-p3[0])*t2 + (-p0[0]+3*p1[0]-3*p2[0]+p3[0])*t3);
      const z = 0.5 * ((2*p1[1]) + (-p0[1]+p2[1])*t + (2*p0[1]-5*p1[1]+4*p2[1]-p3[1])*t2 + (-p0[1]+3*p1[1]-3*p2[1]+p3[1])*t3);
      result.push({ x, z });
    }
  }
  result.push({ ...result[0] });
  let total = 0; const cumulative = [0];
  for (let i = 0; i < result.length - 1; i++) { total += Math.hypot(result[i+1].x-result[i].x, result[i+1].z-result[i].z); cumulative.push(total); }
  return { points: result, cumulative, length: total, width: Number(track.width) || 24 };
}
const TRACK_CACHE = new Map(TRACKS.map(track => [track.id, sampleTrack(track)]));
function getTrackCache(mapId) { return TRACK_CACHE.get(mapId) || TRACK_CACHE.get(DEFAULT_MAP_ID); }

// 자동차 중심에서 도로 중심선까지의 가장 가까운 지점과 누적 거리를 구합니다.
function projectToTrack(x, z, track) {
  let bestDistanceSq = Infinity, bestAlong = 0;
  for (let i = 0; i < track.points.length - 1; i++) {
    const a = track.points[i], b = track.points[i+1];
    const dx = b.x-a.x, dz = b.z-a.z, lenSq = dx*dx+dz*dz;
    const t = lenSq > 0 ? Math.max(0, Math.min(1, ((x-a.x)*dx+(z-a.z)*dz)/lenSq)) : 0;
    const px = a.x+dx*t, pz = a.z+dz*t;
    const ex = x-px, ez = z-pz, distSq = ex*ex+ez*ez;
    if (distSq < bestDistanceSq) { bestDistanceSq = distSq; bestAlong = track.cumulative[i] + Math.sqrt(lenSq)*t; }
  }
  return { distance: Math.sqrt(bestDistanceSq), along: bestAlong };
}

const rooms = new Map();
const sockets = new Set();
let tickCount = 0;
// 홈 화면에 표시할 온라인 인원은 WebSocket만 열린 방문자가 아니라 실제 방에 입장한 참가자 수입니다.
function countOnlinePlayers() {
  let count = 0;
  for (const room of rooms.values()) count += room.players.size;
  return count;
}

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
function raceStandings(room) {
  return [...room.players.values()].sort((a, b) => {
    if (a.finished !== b.finished) return a.finished ? -1 : 1;
    if (a.finished && b.finished) return (a.finishTimeMs + a.penaltyMs) - (b.finishTimeMs + b.penaltyMs);
    return b.raceProgress - a.raceProgress;
  });
}
function roomPlayers(room) {
  const positions = new Map(raceStandings(room).map((p, i) => [p.id, i + 1]));
  return [...room.players.values()].map(p => ({
    id: p.id, name: p.name, vehicleId: p.vehicleId,
    host: p.id === room.hostId,
    x: p.x, z: p.z, yaw: p.yaw, speed: p.speed, surface: p.surface || 'road',
    controls: { ...(p.controls || {}) },
    boostRemaining: Math.max(0, p.boostUntil - Date.now()) / 1000,
    abilityCooldown: Math.max(0, p.abilityReadyAt - Date.now()) / 1000,
    boostsRemaining: Math.max(0, 5 - (p.boostsUsed || 0)),
    tune: room.tune || p.tune || DEFAULT_TUNE,
    drafting: !!p.drafting,
    raceProgress: p.raceProgress || 0,
    lapsCompleted: Math.min(room.race?.lapsToWin || room.lapsToWin || 3, Math.floor((p.raceProgress || 0) / (getTrackCache(room.mapId).length || 1))),
    lapTimes: [...(p.lapTimes || [])],
    bestLapMs: p.lapTimes && p.lapTimes.length ? Math.min(...p.lapTimes) : null,
    collisions: p.collisions || 0,
    penaltyMs: p.penaltyMs || 0,
    finished: !!p.finished,
    finishTimeMs: p.finishTimeMs,
    position: positions.get(p.id) || 0
  }));
}
function sendRoomState(room) {
  const payload = {
    type: 'room-state', roomCode: room.code, hostId: room.hostId,
    started: room.started, mapId: room.mapId || DEFAULT_MAP_ID, lapsToWin: room.lapsToWin || 3, race: room.race || null,
    players: roomPlayers(room), tune: room.tune || DEFAULT_TUNE, maxPlayers: MAX_PLAYERS, serverTime: Date.now()
  };
  for (const p of room.players.values()) safeSend(p.ws, payload);
}
function sendError(ws, message) { safeSend(ws, { type: 'error', message }); }
function spawnPlayer(player, index, count, now, track) {
  const lane = (index % 4 - 1.5) * 4.8;
  const row = Math.floor(index / 4);
  const a = track.points[0], b = track.points[1], previous = track.points[track.points.length - 2];
  // 출발 위치의 접선은 앞/뒤 샘플을 함께 사용해 도로 중심선과 같은 방향으로 맞춥니다.
  const dx = b.x - previous.x, dz = b.z - previous.z, length = Math.max(0.001, Math.hypot(dx, dz));
  const tx = dx / length, tz = dz / length;
  const nx = tz, nz = -tx;
  // 첫 번째 줄은 출발선 근처, 두 번째 줄은 그 뒤에 배치합니다.
  player.x = a.x - tx * row * 8 + nx * lane;
  player.z = a.z - tz * row * 8 + nz * lane;
  player.yaw = Math.atan2(-tx, -tz); // 차량 앞(-Z)을 트랙 진행 방향에 맞춥니다.
  player.speed = 0;
  player.surface = 'road';
  player.controls = { forward: false, reverse: false, left: false, right: false, brake: false };
  player.drafting = false;
  player.boostUntil = 0;
  player.abilityReadyAt = 0;
  player.boostsUsed = 0; // 매 경기마다 5회로 초기화됩니다.
  const projection = projectToTrack(player.x, player.z, track);
  player.lastTrackDistance = projection.along;
  player.raceProgress = 0;
  player.collisions = 0;
  player.penaltyMs = 0;
  player.collisionReadyAt = 0;
  player.finished = false;
  player.finishTimeMs = null;
  player.lapStartedAt = now;
  player.lapTimes = [];
}
function canUseBoost(player, now) {
  if ((player.boostsUsed || 0) >= 5 || now < player.abilityReadyAt) return false;
  player.boostUntil = now + 3000;       // 부스트는 정확히 3초 동안 유지됩니다.
  player.abilityReadyAt = now + 10000;  // 사용 순간부터 10초 뒤 다시 사용할 수 있습니다.
  player.boostsUsed = (player.boostsUsed || 0) + 1;
  return true;
}
// 앞차 바로 뒤에서 일정한 간격을 유지하면 약한 슬립스트림 보너스를 받습니다.
// 가속만 8%, 최고속도는 2.5%만 올리고 부스트와 중복되지 않게 합니다.
function isInSlipstream(player, room) {
  if (player.speed < 6 || player.surface !== 'road') return false;
  const axes = vehicleAxes(player.yaw);
  for (const other of room.players.values()) {
    if (other.id === player.id || other.finished || other.speed < 6 || other.surface !== 'road') continue;
    const dx = other.x - player.x, dz = other.z - player.z;
    const longitudinal = dx * axes.forward.x + dz * axes.forward.z;
    if (longitudinal < 5 || longitudinal > 19) continue;
    const lateral = Math.abs(dx * axes.right.x + dz * axes.right.z);
    if (lateral > 3.3) continue;
    const otherForward = vehicleAxes(other.yaw).forward;
    const headingAgreement = axes.forward.x * otherForward.x + axes.forward.z * otherForward.z;
    if (headingAgreement < 0.94) continue;
    if (other.speed < player.speed - 1.8) continue;
    return true;
  }
  return false;
}

function startRace(room, now, requestedLaps) {
  room.started = true;
  const track = getTrackCache(room.mapId);
  const laps = Math.max(1, Math.min(20, Math.round(Number(requestedLaps ?? room.lapsToWin ?? 3) || 3)));
  room.lapsToWin = laps;
  room.race = {
    status: 'countdown', countdownEndsAt: now + 3000, startedAt: null,
    firstFinisherId: null, finishWindowEndsAt: null,
    lapsToWin: laps, trackLength: track.length, results: null
  };
  const players = [...room.players.values()];
  players.forEach((p, i) => spawnPlayer(p, i, players.length, now + 3000, track));
}
function getRaceFeedback(rank, collisions, completed) {
  if (!completed && rank === 1) return '가장 앞서 달렸어! 남은 랩을 완주하고 충돌을 줄이는 연습을 해 봐.';
  if (rank === 1 && collisions === 0) return '완벽한 클린 레이스! 충돌 없이 1위를 차지했어.';
  if (rank === 1) return '멋진 우승이야! 다음에는 충돌을 줄여 기록을 더 단축해 봐.';
  if (completed && collisions <= 1) return '안정적인 주행이야. 코너 탈출 속도를 조금 더 높여 봐.';
  if (completed) return '완주 성공! 코너 진입 전에 속도를 줄이고 충돌을 줄여 봐.';
  return '이번에는 완주하지 못했지만 괜찮아. 트랙 안쪽을 유지하고 부드럽게 조향해 봐.';
}
function finishRace(room, now) {
  if (!room.race || room.race.status !== 'running') return;
  room.race.status = 'finished';
  room.race.finishedAt = now;
  for (const p of room.players.values()) { p.controls = { forward:false, reverse:false, left:false, right:false, brake:false }; p.speed = 0; p.drafting = false; }
  const ordered = raceStandings(room);
  const results = ordered.map((p, i) => {
    const completedLaps = Math.min(room.race.lapsToWin || 3, Math.floor((p.raceProgress || 0) / (room.race.trackLength || 1)));
    const finished = !!p.finished;
    const elapsedMs = finished && Number.isFinite(p.finishTimeMs) ? p.finishTimeMs : now - room.race.startedAt;
    return {
      id: p.id, rank: i + 1, name: p.name,
      vehicleName: (VEHICLE_MAP.get(p.vehicleId) || VEHICLES[0]).short,
      completedLaps, finished, elapsedMs,
      penaltyMs: p.penaltyMs || 0,
      finalTimeMs: elapsedMs + (p.penaltyMs || 0),
      collisions: p.collisions || 0,
      lapTimes: p.lapTimes || [],
      feedback: getRaceFeedback(i + 1, p.collisions || 0, finished)
    };
  });
  room.race.results = results;
  const payload = { type: 'race-finished', race: room.race, results };
  for (const p of room.players.values()) safeSend(p.ws, payload);
  sendRoomState(room);
}
function updateRaceProgress(room, player, now, track) {
  if (!room.race || room.race.status !== 'running' || player.finished) return;
  const nearest = projectToTrack(player.x, player.z, track);
  const previous = player.lastTrackDistance ?? nearest.along;
  let delta = nearest.along - previous;
  if (delta < -track.length / 2) delta += track.length;
  else if (delta > track.length / 2) delta -= track.length;
  // 도로에서 너무 벗어나거나 한 프레임에 말이 안 되는 거리를 이동하면 랩을 올리지 않습니다.
  const maxStep = Math.max(2.5, Math.abs(player.speed) * 2.2 * (1 / 30) + 1.5);
  if (nearest.distance <= track.width / 2 + 7 && delta > 0 && delta <= maxStep) {
    player.raceProgress = Math.max(0, (player.raceProgress || 0) + delta);
  }
  player.lastTrackDistance = nearest.along;
  const completed = Math.floor((player.raceProgress || 0) / track.length);
  while (player.lapTimes.length < completed) {
    player.lapTimes.push(now - player.lapStartedAt);
    player.lapStartedAt = now;
  }
  if (completed >= room.race.lapsToWin) {
    player.finished = true;
    player.finishTimeMs = now - room.race.startedAt;
    player.speed = 0;
    player.controls = { forward:false, reverse:false, left:false, right:false, brake:false };
    if (!room.race.firstFinisherId) {
      room.race.firstFinisherId = player.id;
      room.race.finishWindowEndsAt = now + 20000;
    }
  }
}
function resolveCarCollisions(room, now) {
  const players = [...room.players.values()].filter(p => !p.finished);
  for (let i = 0; i < players.length; i++) for (let j = i + 1; j < players.length; j++) {
    const a = players[i], b = players[j];
    const contact = orientedBoxContact(a, b);
    if (!contact) continue;

    const { nx, nz, overlap } = contact;
    // 밀어내기는 겹친 양만큼 두 차에 나눠 적용합니다. 접촉 상태가 계속 누적되지 않습니다.
    const correction = Math.max(0, overlap - 0.025) * 0.505;
    a.x -= nx * correction; a.z -= nz * correction;
    b.x += nx * correction; b.z += nz * correction;

    // 충돌 충격은 실제로 서로 접근 중일 때만 작게 전달합니다.
    // 옆면 스침이나 정지 상태의 겹침 때문에 속도가 갑자기 떨어지지 않게 합니다.
    const fa = vehicleAxes(a.yaw).forward;
    const fb = vehicleAxes(b.yaw).forward;
    const avx = fa.x * a.speed, avz = fa.z * a.speed;
    const bvx = fb.x * b.speed, bvz = fb.z * b.speed;
    const closingSpeed = (avx - bvx) * nx + (avz - bvz) * nz;
    if (overlap > 0.08 && closingSpeed > 0.5) {
      const impulse = Math.min(1.25, closingSpeed * 0.075);
      const nextAvx = avx - impulse * nx, nextAvz = avz - impulse * nz;
      const nextBvx = bvx + impulse * nx, nextBvz = bvz + impulse * nz;
      a.speed = nextAvx * fa.x + nextAvz * fa.z;
      b.speed = nextBvx * fb.x + nextBvz * fb.z;
    }

    if (now >= a.collisionReadyAt) { a.collisions++; a.penaltyMs += 500; a.collisionReadyAt = now + 900; }
    if (now >= b.collisionReadyAt) { b.collisions++; b.penaltyMs += 500; b.collisionReadyAt = now + 900; }
  }
}

function publicVehicleUpdate(room, player) {
  for (const other of room.players.values()) {
    if (other.id !== player.id) safeSend(other.ws, { type: 'player-vehicle', playerId: player.id, vehicleId: player.vehicleId });
  }
  sendRoomState(room);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname === '/healthz' || url.pathname === '/api/status') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(JSON.stringify({
      ok: true,
      rooms: rooms.size,
      onlinePlayers: countOnlinePlayers(),
      maxPlayers: MAX_PLAYERS,
      serverTime: Date.now()
    }));
  }
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';
  // 공개 서버는 게임 화면만 제공합니다. server.js와 환경 설정 파일은 다운로드할 수 없습니다.
  const allowedFiles = { '/index.html': ['index.html', 'text/html; charset=utf-8'], '/tracks.json': ['tracks.json', 'application/json; charset=utf-8'] };
  const fileInfo = allowedFiles[pathname];
  if (!fileInfo) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('Not found'); }
  const target = path.join(ROOT, fileInfo[0]);
  fs.readFile(target, (err, data) => {
    if (err) { res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('Game file could not be loaded'); }
    res.writeHead(200, { 'content-type': fileInfo[1], 'cache-control': 'no-cache' });
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
  safeSend(ws, { type: 'connected', message: '온라인 서버에 연결되었습니다.' });

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return sendError(ws, '잘못된 메시지 형식입니다.'); }
    if (!msg || typeof msg.type !== 'string') return;

    if (msg.type === 'create-room') {
      if (ws.player) return sendError(ws, '이미 방에 참가 중입니다.');
      const name = sanitizeName(msg.name);
      const vehicle = VEHICLE_MAP.get(String(msg.vehicleId || 'grandeur')) || VEHICLES[0];
      const code = makeRoomCode();
      const sharedTune = sanitizeTune(msg.tune);
      const player = makePlayer(ws, name, vehicle.id, sharedTune);
      const mapId = TRACK_MAP.has(String(msg.mapId || '')) ? String(msg.mapId) : DEFAULT_MAP_ID;
      const room = { code, hostId: player.id, started: false, mapId, tune: sharedTune, players: new Map() };
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
      const player = makePlayer(ws, name, vehicle.id, room.tune || DEFAULT_TUNE);
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
      ws.player.vehicleId = vehicle.id;
      publicVehicleUpdate(ws.room, ws.player);
      return;
    }

    if (msg.type === 'tune') {
      if (!ws.player || !ws.room) return sendError(ws, '먼저 온라인 방에 참가해 주세요.');
      if (ws.room.started) return sendError(ws, '레이스 중에는 튜닝할 수 없습니다.');
      if (ws.room.hostId !== ws.player.id) return sendError(ws, '공통 튜닝은 방장만 변경할 수 있습니다.');
      ws.room.tune = sanitizeTune(msg.tune);
      for (const member of ws.room.players.values()) member.tune = ws.room.tune;
      sendRoomState(ws.room);
      return;
    }

    if (msg.type === 'select-map') {
      if (!ws.player || !ws.room) return sendError(ws, '먼저 온라인 방을 만들어 주세요.');
      if (ws.room.started) return sendError(ws, '레이스 중에는 맵을 바꿀 수 없습니다.');
      if (ws.room.hostId !== ws.player.id) return sendError(ws, '방장만 맵을 선택할 수 있습니다.');
      const mapId = String(msg.mapId || '');
      if (!TRACK_MAP.has(mapId)) return sendError(ws, '존재하지 않는 맵입니다.');
      ws.room.mapId = mapId;
      sendRoomState(ws.room);
      return;
    }

    if (msg.type === 'start-room') {
      if (!ws.player || !ws.room) return sendError(ws, '온라인 방에 참가해 주세요.');
      if (ws.room.hostId !== ws.player.id) return sendError(ws, '방장만 게임을 시작할 수 있습니다.');
      if (ws.room.started) return;
      if (ws.room.race && ['countdown','running'].includes(ws.room.race.status)) return sendError(ws, '레이스가 이미 진행 중입니다.');
      ws.room.lapsToWin = Math.max(1, Math.min(20, Math.round(Number(msg.lapsToWin) || 3)));
      startRace(ws.room, Date.now(), ws.room.lapsToWin);
      sendRoomState(ws.room);
      return;
    }

    if (msg.type === 'restart-race') {
      if (!ws.player || !ws.room || ws.room.hostId !== ws.player.id) return sendError(ws, '방장만 재경기를 시작할 수 있습니다.');
      if (!ws.room.race || ws.room.race.status !== 'finished') return sendError(ws, '현재 레이스가 끝난 뒤 다시 시작할 수 있습니다.');
      startRace(ws.room, Date.now(), ws.room.lapsToWin || ws.room.race.lapsToWin || 3);
      sendRoomState(ws.room);
      return;
    }

    if (msg.type === 'stop-room') {
      if (!ws.player || !ws.room || ws.room.hostId !== ws.player.id) return sendError(ws, '방장만 대기실로 돌아갈 수 있습니다.');
      ws.room.started = false;
      ws.room.race = null;
      for (const p of ws.room.players.values()) {
        p.speed = 0; p.drafting = false;
        p.controls = { forward: false, reverse: false, left: false, right: false, brake: false };
      }
      sendRoomState(ws.room);
      return;
    }

    if (msg.type === 'input') {
      if (!ws.player || !ws.room || ws.room.race?.status !== 'running') return;
      const c = msg.controls || {};
      ws.player.controls = {
        forward: !!c.forward, reverse: !!c.reverse,
        left: !!c.left, right: !!c.right, brake: !!c.brake
      };
      return;
    }

    if (msg.type === 'ability') {
      if (!ws.player || !ws.room || ws.room.race?.status !== 'running') return;
      const now = Date.now();
      const ok = canUseBoost(ws.player, now);
      safeSend(ws, { type: 'ability-result', ok, boostRemaining: Math.max(0, ws.player.boostUntil - now) / 1000, cooldown: Math.max(0, ws.player.abilityReadyAt - now) / 1000, boostsRemaining: Math.max(0, 5 - ws.player.boostsUsed), message: ok ? '3초 부스트 발동! (경기당 최대 5회)' : (ws.player.boostsUsed >= 5 ? '이번 경기의 부스트 5회를 모두 사용했습니다.' : '부스트 대기 시간이 끝나면 다시 사용할 수 있어요.') });
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

function makePlayer(ws, name, vehicleId, tuneInput) {
  return {
    id: crypto.randomUUID(), ws, name, vehicleId, tune: sanitizeTune(tuneInput), drafting: false,
    x: 0, z: 0, yaw: -Math.PI / 2, speed: 0,
    controls: { forward: false, reverse: false, left: false, right: false, brake: false },
    boostUntil: 0, abilityReadyAt: 0, boostsUsed: 0, raceProgress: 0, lastTrackDistance: 0, collisions: 0, penaltyMs: 0, collisionReadyAt: 0, finished: false, finishTimeMs: null, lapStartedAt: 0, lapTimes: []
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
  const dt = Math.min(0.045, Math.max(0, (now - lastTick) / 1000));
  lastTick = now;
  if (dt <= 0) return;
  tickCount++;
  for (const room of rooms.values()) {
    if (!room.started || !room.race) continue;
    if (room.race.status === 'countdown') {
      if (now >= room.race.countdownEndsAt) {
        room.race.status = 'running';
        room.race.startedAt = now;
        room.race.goBannerUntil = now + 550;
        for (const p of room.players.values()) {
          p.lapStartedAt = now;
          p.controls = { forward:false, reverse:false, left:false, right:false, brake:false };
        }
      }
      const countdownPayload = { type: 'snapshot', roomCode: room.code, players: roomPlayers(room), race: room.race, serverTime: now };
      for (const p of room.players.values()) safeSend(p.ws, countdownPayload);
      if (room.race.status !== 'running') continue;
    }
    if (room.race.status !== 'running') continue;
    for (const p of room.players.values()) {
      if (p.finished) continue;
      const c = p.controls;
      const tune = room.tune || p.tune || DEFAULT_TUNE;
      p.tune = tune; // 방 안의 모든 차량은 방장이 확정한 동일 튜닝값을 사용합니다.
      const boosting = now < p.boostUntil;
      const surface = p.surface || 'road';
      // 잔디·흙 감속을 완만하게 해 실수 후에도 레이스에 복귀할 수 있게 합니다.
      const surfaceGrip = surface === 'grass' ? 0.90 : surface === 'dirt' ? 0.80 : 1;
      const surfacePower = surface === 'grass' ? 0.92 : surface === 'dirt' ? 0.82 : 1;
      const drafting = !boosting && isInSlipstream(p, room);
      p.drafting = drafting;
      const draftTopSpeed = drafting ? 1.025 : 1;
      const draftAcceleration = drafting ? 1.08 : 1;
      const maxSpeed = tune.topSpeed * (boosting ? 1.18 : 1) * surfacePower * draftTopSpeed;
      const accel = tune.acceleration * (boosting ? 1.25 : 1) * surfacePower * draftAcceleration;
      const brake = tune.brake;
      const reverse = tune.reverse * surfacePower;
      if (c.forward) p.speed = Math.min(maxSpeed, p.speed + accel * dt);
      if (c.reverse) {
        if (p.speed > 0.8) p.speed = Math.max(0, p.speed - brake * dt);
        else p.speed = Math.max(-reverse, p.speed - accel * 0.48 * dt);
      }
      if (c.brake) p.speed = p.speed > 0 ? Math.max(0, p.speed - brake * 1.45 * dt) : Math.min(0, p.speed + brake * 1.45 * dt);
      if (!c.forward && !c.reverse && !c.brake) p.speed *= Math.exp(-tune.coastDrag * dt);
      if (Math.abs(p.speed) < 0.025 && !c.forward && !c.reverse) p.speed = 0;
      const speedRatio = Math.min(1, Math.abs(p.speed) / Math.max(1, tune.topSpeed));
      // Grip(접지력)이 높을수록 같은 조향 입력이 조금 더 안정적으로 적용됩니다.
      const steerRate = tune.steering * 0.30 * (0.23 + speedRatio * 0.77) * (0.78 + tune.grip * 0.22) * surfaceGrip;
      const direction = p.speed >= 0 ? 1 : -1;
      if (c.left) p.yaw += steerRate * direction * dt;
      if (c.right) p.yaw -= steerRate * direction * dt;
      if (c.left || c.right) p.speed *= Math.exp(-(0.035 / tune.grip / surfaceGrip) * dt);
      // The vehicle model faces local -Z, so the physics vector must use -sin(yaw).
      p.x -= Math.sin(p.yaw) * p.speed * dt;
      p.z -= Math.cos(p.yaw) * p.speed * dt;
      const track = getTrackCache(room.mapId);
      const roadDistance = projectToTrack(p.x, p.z, track).distance;
      const roadEdge = track.width / 2;
      // 도로 가장자리를 벗어나면 잔디, 더 멀리 벗어나면 흙/모래 노면으로 판정합니다.
      p.surface = roadDistance <= roadEdge ? 'road' : roadDistance <= roadEdge + 18 ? 'grass' : 'dirt';
      if (p.surface === 'grass') p.speed *= Math.exp(-0.25 * dt);
      else if (p.surface === 'dirt') p.speed *= Math.exp(-0.55 * dt);
      // 노면 제한은 살짝만 적용합니다. 도로로 복귀할 수 있도록 속도를 크게 깎지 않습니다.
      const surfaceRatio = p.surface === 'grass' ? 0.92 : p.surface === 'dirt' ? 0.82 : 1;
      const surfaceLimit = tune.topSpeed * (boosting ? 1.18 : 1) * surfaceRatio * (p.drafting && !boosting ? 1.025 : 1);
      p.speed = Math.max(-tune.reverse * surfaceRatio, Math.min(surfaceLimit, p.speed));
      p.x = Math.max(-420, Math.min(420, p.x));
      p.z = Math.max(-520, Math.min(520, p.z));
      updateRaceProgress(room, p, now, track);
    }
    resolveCarCollisions(room, now);
    if (room.race.finishWindowEndsAt && now >= room.race.finishWindowEndsAt) finishRace(room, now);
    if (room.race?.status === 'running' && tickCount % SNAPSHOT_EVERY === 0) {
      const payload = { type: 'snapshot', roomCode: room.code, players: roomPlayers(room), race: room.race, serverTime: now };
      for (const p of room.players.values()) safeSend(p.ws, payload);
    }
  }
}, TICK_MS);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`MISTWOOD Online server listening on port ${PORT}`);
});
