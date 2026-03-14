// server.js — adaptado para YouTube embed + sincronização via socket.io
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const os = require("os");
const axios = require("axios");

const app = express();
const server = http.createServer(app);
// permitindo CORS básico pro Socket.IO (útil em dev / testes)
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

// ---------- YouTube API key (fictícia que você pediu para incluir) ----------
const YT_API_KEY = process.env.YT_API_KEY || "AIzaSyDSWsuBjVjknRxnz6GHPMWlnTwFSAsTUf4";

// ---------- uploads dir ----------
const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
  console.log("📁 Pasta uploads criada:", uploadsDir);
}

// ---------- multer ----------
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const safe = file.originalname.replace(/\s+/g, "_").replace(/[^a-zA-Z0-9._-]/g, "");
    cb(null, `${Date.now()}-${safe}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 1024 * 1024 * 1024 }, // 1GB
});

// ---------- middlewares ----------
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} → ${req.method} ${req.url}`);
  next();
});
app.use("/videos", express.static(uploadsDir));
app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ---------- in-memory storage ----------
app.locals.rooms = app.locals.rooms || {};         // room -> string (videoPath) OR object { youtube: id, meta }
app.locals.roomsState = app.locals.roomsState || {}; // room -> { time, playing, ts }
app.locals.chatHistory = app.locals.chatHistory || {}; // room -> [messages]
app.locals.roomInfos = app.locals.roomInfos || {}; // room -> { name, owner, hasPassword, users, createdAt, preview }

// ---------- helpers ----------
function sanitizeText(t){
  if (!t) return "";
  return String(t).replace(/</g,"&lt;").replace(/>/g,"&gt;").trim();
}

function getLocalIPs() {
  const nets = os.networkInterfaces();
  const results = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        results.push(net.address);
      }
    }
  }
  return results;
}

// robust room name extraction
function getRoomName(payload) {
  if (!payload) return "";
  if (typeof payload === "string") return payload.trim();
  if (typeof payload === "object") {
    const candidate =
      (typeof payload.room === "string" && payload.room) ||
      (typeof payload.name === "string" && payload.name) ||
      (typeof payload.roomName === "string" && payload.roomName) ||
      (typeof payload.id === "string" && payload.id) ||
      "";
    if (candidate && String(candidate).trim()) return String(candidate).trim();

    if (payload.room && typeof payload.room === "object") {
      const inner = payload.room.name || payload.room.id || "";
      if (inner && String(inner).trim()) return String(inner).trim();
    }
    if (payload && payload.name) return String(payload.name).trim();
    if (payload && payload.room) return String(payload.room).trim();
    if (payload && payload.toString) {
      const s = payload.toString();
      if (s && s !== "[object Object]") return s.trim();
    }
    return "";
  }
  return String(payload).trim();
}

// push system chat (join/leave)
function pushSystemChat(room, type, user, text) {
  try {
    if (!room) return;
    const username = sanitizeText(user) || `Convidado`;
    const msg = {
      id: Date.now() + "-" + Math.random().toString(36).slice(2,8),
      user: username,
      text: text || `${username} ${type === 'join' ? 'entrou' : 'saiu'} da sala`,
      ts: Date.now(),
      system: true,
      type
    };
    app.locals.chatHistory[room] = app.locals.chatHistory[room] || [];
    app.locals.chatHistory[room].push(msg);
    if (app.locals.chatHistory[room].length > 300) app.locals.chatHistory[room].shift();
    // envia para todos na sala
    io.in(room).emit("chat-message", msg);
  } catch (err) {
    console.warn("pushSystemChat failed", err);
  }
}

// helper: broadcast current rooms-list (both event names for compatibility)
function broadcastRoomsList() {
  const arr = Object.values(app.locals.roomInfos || {}).map(info => ({
    name: info.name,
    owner: info.owner,
    hasPassword: !!info.hasPassword,
    users: info.users || 0,
    createdAt: info.createdAt || 0,
    preview: info.preview || null
  }));
  io.emit("rooms-list", arr);
  io.emit("room-list", arr); // legacy / alternate name
}

// ---------- upload endpoints ----------
app.post("/upload/:room", (req, res, next) => {
  upload.single("video")(req, res, (err) => {
    if (err) return next(err);
    if (!req.file) {
      console.log("❌ Upload sem arquivo em /upload/:room");
      return res.status(400).json({ error: "Arquivo não enviado" });
    }
    const room = req.params.room;
    const videoPath = `/videos/${req.file.filename}`;
    app.locals.rooms[room] = videoPath;
    console.log("✅ Upload salvo:", videoPath, "para sala:", room);

    app.locals.roomInfos[room] = app.locals.roomInfos[room] || {
      name: room,
      owner: null,
      hasPassword: false,
      users: io.sockets.adapter.rooms.get(room)?.size || 0,
      createdAt: Date.now(),
      preview: null
    };
    app.locals.roomInfos[room].preview = videoPath;
    io.emit("room-updated", app.locals.roomInfos[room]);
    broadcastRoomsList();

    io.to(room).emit("video-ready", videoPath);
    return res.json({ success: true, video: videoPath });
  });
});

app.post("/upload", (req, res, next) => {
  upload.single("video")(req, res, (err) => {
    if (err) return next(err);
    if (!req.file) {
      console.log("❌ Upload sem arquivo em /upload");
      return res.status(400).json({ error: "Arquivo não enviado" });
    }
    const room = (req.body && req.body.room) || "";
    if (!room) {
      console.log("❌ Upload sem room em /upload");
      return res.status(400).json({ error: "Campo 'room' ausente" });
    }
    const videoPath = `/videos/${req.file.filename}`;
    app.locals.rooms[room] = videoPath;
    console.log("✅ Upload salvo:", videoPath, "para sala:", room);

    app.locals.roomInfos[room] = app.locals.roomInfos[room] || {
      name: room,
      owner: null,
      hasPassword: false,
      users: io.sockets.adapter.rooms.get(room)?.size || 0,
      createdAt: Date.now(),
      preview: null
    };
    app.locals.roomInfos[room].preview = videoPath;
    io.emit("room-updated", app.locals.roomInfos[room]);
    broadcastRoomsList();

    io.to(room).emit("video-ready", videoPath);
    return res.json({ success: true, video: videoPath });
  });
});

// health
app.get("/health", (req, res) => res.json({ ok: true }));

// rota para listar salas via HTTP (útil pra debug / fetch)
app.get("/rooms", (req, res) => {
  const arr = Object.values(app.locals.roomInfos || {}).map(info => ({
    name: info.name,
    owner: info.owner,
    hasPassword: !!info.hasPassword,
    users: info.users || 0,
    createdAt: info.createdAt || 0,
    preview: info.preview || null
  }));
  res.json({ rooms: arr });
});

// ---------- YouTube Data API helper (server-side) ----------
async function fetchYouTubeMetaServer(id) {
  if (!YT_API_KEY) throw new Error("YT_API_KEY não definida no servidor");
  const url = `https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails,status&id=${encodeURIComponent(id)}&key=${YT_API_KEY}`;
  try {
    const resp = await axios.get(url, { timeout: 8000 });
    if (!resp.data || !Array.isArray(resp.data.items) || resp.data.items.length === 0) {
      throw new Error("Vídeo não encontrado");
    }
    const it = resp.data.items[0];
    return {
      id,
      title: it.snippet?.title || "",
      channelTitle: it.snippet?.channelTitle || "",
      thumbnails: it.snippet?.thumbnails || {},
      durationISO: it.contentDetails?.duration || null,
      embeddable: typeof it.status?.embeddable === "boolean" ? !!it.status.embeddable : true,
    };
  } catch (err) {
    const m = (err && err.response && err.response.data) ? JSON.stringify(err.response.data) : (err && err.message ? err.message : String(err));
    throw new Error("YouTube API error: " + m);
  }
}

// ---------- Socket.IO ----------
io.on("connection", (socket) => {
  console.log("🔌 socket conectado:", socket.id);

  socket._chatRate = { lastTs: 0, windowStart: Date.now(), count: 0 };
  function getRoomMembers(room){
  const set = io.sockets.adapter.rooms.get(room);
  if (!set) return [];

  const members = [];

  for (const id of set) {
    const s = io.sockets.sockets.get(id);
    if (!s) continue;

    members.push({
      id,
      name: s.data?.username || `Guest-${id.slice(0,6)}`,
      status: "online"
    });
  }

  return members;
}

// cliente pediu lista de membros
socket.on("request_room_members", (payload) => {

  const room = getRoomName(payload);

  if (!room){
    socket.emit("room_members", []);
    return;
  }

  const members = getRoomMembers(room);

  socket.emit("room_members", members);
});


  // create-room: host explicitly creates a room
  socket.on("create-room", (payload, maybeAck) => {
    try {
      const roomName = getRoomName(payload);
      if (!roomName) {
        if (typeof maybeAck === "function") maybeAck({ ok: false, error: "Nome da sala inválido" });
        return;
      }

      const currentRooms = Array.from(socket.rooms).filter(r => r !== socket.id);
      if (currentRooms.length > 0) {
        if (typeof maybeAck === "function") maybeAck({ ok: false, error: "Você já está em uma sala. Saia antes de criar outra." });
        return;
      }

      if (app.locals.roomInfos[roomName]) {
        if (typeof maybeAck === "function") maybeAck({ ok: false, error: "Sala com esse nome já existe" });
        return;
      }

      // host (owner id) field (kept for owner tracking)
      const ownerId = payload && payload.host ? String(payload.host).slice(0, 40) : socket.id;

      // Rastreia username (tolerante a vários campos)
      const creatorName = sanitizeText(
        (payload && (payload.username || payload.user || payload.name || payload.host || payload.owner || payload.ownerName))
      ) || (`Host-${socket.id.slice(0,6)}`);
      socket.data.username = creatorName;

      socket.join(roomName);

      console.log(`👑 ${socket.id} (${creatorName}) criou a sala ${roomName}`);

      io.in(roomName).emit("room_members", getRoomMembers(roomName));
      


      app.locals.roomsState[roomName] = { time: 0, playing: false, ts: Date.now() };

      const preview = app.locals.rooms[roomName] || null;

      app.locals.roomInfos[roomName] = {
        name: roomName,
        owner: ownerId,
        password: payload.password || null,
        hasPassword: !!payload.password,
        users: io.sockets.adapter.rooms.get(roomName)?.size || 0,
        createdAt: Date.now(),
        preview
      };


      if (app.locals.rooms[roomName]) socket.emit("video-ready", app.locals.rooms[roomName]);
      socket.emit("sync", app.locals.roomsState[roomName]);
      socket.emit("chat-history", app.locals.chatHistory[roomName] || []);

      // update size and registry
      const size = io.sockets.adapter.rooms.get(roomName)?.size || 0;
      app.locals.roomInfos[roomName].users = size;

      // system message: creator created & joined
      pushSystemChat(roomName, 'join', creatorName, `${creatorName} criou e entrou na sala`);

      // broadcast room created/updated and lists (both event names)
      io.emit("room-created", app.locals.roomInfos[roomName]);
      io.emit("room-updated", app.locals.roomInfos[roomName]);
      broadcastRoomsList();

      // send room-count to participants
      io.in(roomName).emit("room-count", size);

      if (typeof maybeAck === "function") maybeAck({ ok: true, room: roomName });

    } catch (err) {
      console.error("Erro em create-room:", err);
      if (typeof maybeAck === "function") maybeAck({ ok: false, error: String(err) });
    }
  });

  // join-room: join & receive current video + state + history
  socket.on("join-room", (payload, maybeAck) => {
    try {
      const roomName = getRoomName(payload);
      if (!roomName) {
        if (typeof maybeAck === "function") maybeAck({ ok: false, error: "room inválida" });
        return;
      }

      const otherRooms = Array.from(socket.rooms).filter(r => r !== socket.id);
      if (otherRooms.length > 0) {
        if (typeof maybeAck === "function") {
          maybeAck({ ok: false, error: "Você já está em outra sala. Saia antes de entrar." });
        }
        return;
      }

      const roomInfo = app.locals.roomInfos[roomName];
      if (!roomInfo) {
        if (typeof maybeAck === "function") maybeAck({ ok: false, error: "Sala não existe" });
        return;
      }

      if (roomInfo.hasPassword) {
        if (!payload.password || payload.password !== roomInfo.password) {
          if (typeof maybeAck === "function") maybeAck({ ok: false, error: "Senha incorreta" });
          socket.emit("join-error", { error: "Senha incorreta" });
          return;
        }
      }

      // register username for this socket (tolerant)
      const username = sanitizeText((payload && (payload.username || payload.user || payload.name || payload.host || payload.owner || payload.ownerName))) || (`Guest-${socket.id.slice(0,6)}`);
      socket.data.username = username;

      socket.join(roomName);
      console.log(`👥 ${socket.id} (${username}) entrou em ${roomName}`);
      io.in(roomName).emit("room_members", getRoomMembers(roomName));


      // recompute size after join
      const size = io.sockets.adapter.rooms.get(roomName)?.size || 0;
      if (app.locals.roomInfos[roomName]) app.locals.roomInfos[roomName].users = size;

      // atualizar lobby (ambos eventos)
      io.emit("rooms-list", Object.values(app.locals.roomInfos));
      io.emit("room-list", Object.values(app.locals.roomInfos));

      // envia estado/vídeo/histórico para o novo participante
      if (app.locals.rooms[roomName]) socket.emit("video-ready", app.locals.rooms[roomName]);
      if (app.locals.roomsState[roomName]) socket.emit("sync", app.locals.roomsState[roomName]);
      socket.emit("chat-history", app.locals.chatHistory[roomName] || []);

      // registra e emite mensagem de sistema no chat (join)
      pushSystemChat(roomName, 'join', username, `${username} entrou na sala`);

      // informe participantes da sala com contagem atual (em tempo real)
      io.in(roomName).emit("room-count", size);

      // informe o lobby (outros clientes) sobre atualização
      io.emit("room-updated", {
        name: app.locals.roomInfos[roomName].name,
        owner: app.locals.roomInfos[roomName].owner,
        hasPassword: !!app.locals.roomInfos[roomName].hasPassword,
        users: app.locals.roomInfos[roomName].users,
        createdAt: app.locals.roomInfos[roomName].createdAt,
        preview: app.locals.roomInfos[roomName].preview || null
      });
      broadcastRoomsList();

      if (typeof maybeAck === "function") maybeAck({ ok: true });
    } catch (err) {
      console.error("Erro em join-room:", err);
      if (typeof maybeAck === "function") maybeAck({ ok: false, error: String(err) });
    }
  });

  // list-rooms (single-client request) -> emit both names for compatibility
  socket.on("list-rooms", () => {
    const arr = Object.values(app.locals.roomInfos || {}).map(info => ({
      name: info.name,
      owner: info.owner,
      hasPassword: !!info.hasPassword,
      users: info.users || 0,
      createdAt: info.createdAt || 0,
      preview: info.preview || null
    }));
    socket.emit("room-list", arr);
    socket.emit("rooms-list", arr);
  });

  // youtube handler (unchanged semântica)
  socket.on("youtube", async (payload, ack) => {
    try {
      if (!payload || !payload.room) {
        if (typeof ack === 'function') ack({ ok: false, error: "payload.room ausente" });
        return;
      }
      const room = getRoomName(payload);
      if (!room) {
        if (typeof ack === 'function') ack({ ok: false, error: "room inválida" });
        return;
      }

      const rawId = (payload.id || payload.youtube || "").toString().trim();
      const id = rawId.length === 11 ? rawId : (rawId.split(/[?&]/)[0] || rawId);
      if (!id || id.length < 8) {
        console.log("⚠️ youtube emit inválido de", socket.id, payload);
        if (typeof ack === 'function') ack({ ok: false, error: "ID inválido" });
        return;
      }

      let meta;
      try {
        meta = await fetchYouTubeMetaServer(id);
      } catch (err) {
        console.warn("YT validation failed for id", id, "err:", err.message || err);
        if (typeof ack === 'function') ack({ ok: false, error: "Vídeo inválido ou erro YouTube API: " + (err.message || String(err)) });
        return;
      }

      if (!meta.embeddable) {
        if (typeof ack === 'function') ack({ ok: false, error: "Vídeo não permite incorporação (embeddable=false)" });
        return;
      }

      app.locals.rooms[room] = { youtube: id, meta };

      app.locals.roomInfos[room] = app.locals.roomInfos[room] || {
        name: room,
        owner: null,
        hasPassword: false,
        users: io.sockets.adapter.rooms.get(room)?.size || 0,
        createdAt: Date.now(),
        preview: null
      };
      app.locals.roomInfos[room].preview = { youtube: id, meta };

      io.to(room).emit("video-ready", { youtube: id, meta });
      io.to(room).emit("youtube", { id, room, from: socket.id, meta });

      io.emit("room-updated", app.locals.roomInfos[room]);
      broadcastRoomsList();

      console.log(`▶️ YouTube ${id} validado e enviado para sala ${room} por ${socket.id}`);

      if (typeof ack === 'function') ack({ ok: true, id });
    } catch (err) {
      console.error("Erro no handler 'youtube':", err);
      if (typeof ack === 'function') ack({ ok: false, error: String(err) });
    }
  });

  // control
  socket.on("control", ({ room, time, playing }) => {
    try {
      const roomName = getRoomName(room || {});
      if (!roomName) return;
      const ts = Date.now();
      app.locals.roomsState[roomName] = { time: Number(time) || 0, playing: !!playing, ts };
      io.in(roomName).emit("sync", app.locals.roomsState[roomName]);
      console.log(`📡 control from ${socket.id} for ${roomName} => time=${time}, playing=${playing}, ts=${ts}`);
    } catch (err) {
      console.error("Erro em control handler:", err);
    }
  });

  // chat-message
  socket.on("chat-message", (payload) => {
    try {
      if (!payload || !payload.room || !payload.text) return;
      const room = getRoomName(payload.room);
      if (!room) return;
      const now = Date.now();
      const rate = socket._chatRate;
      if (now - rate.windowStart > 10000) { rate.windowStart = now; rate.count = 0; }
      rate.count++;
      if (rate.count > 12) {
        socket.emit("chat-error", { error: "Rate limit. Espere um pouco antes de enviar outra mensagem." });
        return;
      }
      const user = payload.user ? sanitizeText(payload.user).slice(0, 40) : (socket.data.username || `Guest-${socket.id.slice(0,6)}`);
      const text = sanitizeText(payload.text).slice(0, 800);
      if (!text) return;

      const msg = {
        id: Date.now() + "-" + Math.random().toString(36).slice(2,8),
        user,
        text,
        ts: Date.now()
      };

      app.locals.chatHistory[room] = app.locals.chatHistory[room] || [];
      app.locals.chatHistory[room].push(msg);
      if (app.locals.chatHistory[room].length > 300) app.locals.chatHistory[room].shift();

      io.in(room).emit("chat-message", msg);
      console.log(`💬 [${room}] ${user}: ${text}`);
    } catch (err) {
      console.error("Erro chat-message:", err);
    }
  });

  // clear-chat
  socket.on("clear-chat", (roomPayload) => {
    try {
      const room = getRoomName(roomPayload);
      if (!room) return;
      app.locals.chatHistory[room] = [];
      io.in(room).emit("chat-cleared");
    } catch (err) {
      console.error("Erro clear-chat:", err);
    }
  });

  // leave-room
  socket.on("leave-room", (roomName, ack) => {
    if (!roomName) {
      if (typeof ack === "function") ack({ ok: false, error: "room inválida" });
      return;
    }
    const rn = getRoomName(roomName);
    if (!rn) {
      if (typeof ack === "function") ack({ ok: false, error: "room inválida" });
      return;
    }

    console.log(`🚪 ${socket.id} (${socket.data.username || 'Guest'}) saiu de ${rn}`);

    try {
      const username = socket.data.username || `Guest-${socket.id.slice(0,6)}`;
      const msg = {
        id: Date.now() + "-" + Math.random().toString(36).slice(2,8),
        user: sanitizeText(username),
        text: `${username} saiu da sala`,
        ts: Date.now(),
        system: true,
        type: 'leave'
      };
      app.locals.chatHistory[rn] = app.locals.chatHistory[rn] || [];
      app.locals.chatHistory[rn].push(msg);
      if (app.locals.chatHistory[rn].length > 300) app.locals.chatHistory[rn].shift();
      socket.to(rn).emit("chat-message", msg);
    } catch (e) {
      console.warn("leave-room push chat failed", e);
    }

    socket.leave(rn);

    setImmediate(() => {
      const size = io.sockets.adapter.rooms.get(rn)?.size || 0;

      io.in(rn).emit("room_members", getRoomMembers(rn));
      

      if (size === 0) {
        console.log(`🗑 removendo sala vazia: ${rn}`);
        delete app.locals.roomInfos[rn];
        delete app.locals.rooms[rn];
        delete app.locals.roomsState[rn];
        delete app.locals.chatHistory[rn];
        io.emit("room-removed", { name: rn });
      } else {
        if (app.locals.roomInfos[rn]) {
          app.locals.roomInfos[rn].users = size;
          io.emit("room-updated", app.locals.roomInfos[rn]);
        }
      }

      // always broadcast updated rooms list
      broadcastRoomsList();

      if (typeof ack === "function") ack({ ok: true });
    });
  });

  // disconnecting
  socket.on("disconnecting", () => {
    const rooms = Array.from(socket.rooms || []).filter(r => r !== socket.id);
    rooms.forEach(r => {
      try {
        const username = socket.data.username || `Guest-${socket.id.slice(0,6)}`;
        const msg = {
          id: Date.now() + "-" + Math.random().toString(36).slice(2,8),
          user: sanitizeText(username),
          text: `${username} desconectou`,
          ts: Date.now(),
          system: true,
          type: 'leave'
        };
        app.locals.chatHistory[r] = app.locals.chatHistory[r] || [];
        app.locals.chatHistory[r].push(msg);
        if (app.locals.chatHistory[r].length > 300) app.locals.chatHistory[r].shift();
        socket.to(r).emit("chat-message", msg);
      } catch (e) {
        console.warn("disconnecting push chat failed", e);
      }

      setImmediate(() => {
        const size = io.sockets.adapter.rooms.get(r)?.size || 0;
        io.in(r).emit("room_members", getRoomMembers(r));

        if (app.locals.roomInfos[r]) app.locals.roomInfos[r].users = size;
        io.in(r).emit("room-count", size);

        if (size === 0 && app.locals.roomInfos[r]) {
          console.log("🗑 sala removida automaticamente:", r);
          delete app.locals.roomInfos[r];
          delete app.locals.rooms[r];
          delete app.locals.roomsState[r];
          delete app.locals.chatHistory[r];
          io.emit("room-removed", { name: r });
        } else {
          if (app.locals.roomInfos[r]) io.emit("room-updated", app.locals.roomInfos[r]);
        }

        // always broadcast updated rooms list
        broadcastRoomsList();
      });
    });
  });

  socket.on("disconnect", () => {
    console.log("❌ desconectou:", socket.id);
  });
});

// ---------- error handler ----------
app.use((err, req, res, next) => {
  console.error("🔴 ERRO:", err && err.message ? err.message : err);
  if (err instanceof multer.MulterError) {
    return res.status(413).json({ error: err.message });
  }
  if (req.url && req.url.startsWith("/upload")) {
    return res.status(500).json({ error: "Erro no servidor durante upload" });
  }
  next(err);
});

// ---------- start ----------
const PORT = process.env.PORT || 3000;
const HOST = "0.0.0.0";

server.listen(PORT, HOST, () => {
  console.log(`🚀 Servidor escutando em ${HOST}:${PORT}`);
  console.log(`→ YT_API_KEY presente? ${!!YT_API_KEY}`);
  const ips = getLocalIPs();
  if (ips.length) {
    ips.forEach(ip => console.log(`→ Acesse pela rede local: http://${ip}:${PORT}`));
  } else {
    console.log(`→ Se estiver tudo local, acesse: http://localhost:${PORT}`);
  }
});