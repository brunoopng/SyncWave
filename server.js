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
// ATENÇÃO: em produção prefira usar process.env.YT_API_KEY e NÃO expor a chave no frontend.
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

// NEW: informações exibidas no LOBBY (name, owner, hasPassword, users, createdAt, preview)
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

// ---------- New helper: robust room name extraction ----------
function getRoomName(payload) {
  if (!payload) return "";
  if (typeof payload === "string") return payload.trim();
  if (typeof payload === "object") {
    // aceita várias formas: { room }, { name }, { roomName }, { id }
    const candidate =
      (typeof payload.room === "string" && payload.room) ||
      (typeof payload.name === "string" && payload.name) ||
      (typeof payload.roomName === "string" && payload.roomName) ||
      (typeof payload.id === "string" && payload.id) ||
      "";
    if (candidate && String(candidate).trim()) return String(candidate).trim();

    // se payload.room for objeto (ex: { room: { name: 'x' }})
    if (payload.room && typeof payload.room === "object") {
      const inner = payload.room.name || payload.room.id || "";
      if (inner && String(inner).trim()) return String(inner).trim();
    }
    // fallback: try to coerce any other likely fields
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
    // store as string (legacy behavior for direct uploads)
    app.locals.rooms[room] = videoPath;
    console.log("✅ Upload salvo:", videoPath, "para sala:", room);

    // Atualiza preview no registry do lobby
    app.locals.roomInfos[room] = app.locals.roomInfos[room] || {
      name: room,
      owner: null,
      hasPassword: false,
      users: io.sockets.adapter.rooms.get(room)?.size || 0,
      createdAt: Date.now(),
      preview: null
    };
    app.locals.roomInfos[room].preview = videoPath;
    // notifica todos que a sala foi atualizada (tem preview agora)
    io.emit("room-updated", app.locals.roomInfos[room]);

    // notify room (clients expect 'video-ready' with same payload shape)
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

    // Atualiza preview / registry
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

  // simple rate limiter per socket for chat: { lastTs, windowStart, count }
  socket._chatRate = { lastTs: 0, windowStart: Date.now(), count: 0 };

  // create-room: host explicitly creates a room
  socket.on("create-room", (payload) => {
    try {
      const roomName = getRoomName(payload);
      if (!roomName) {
        console.warn("create-room recebido sem room válido:", payload);
        return;
      }
      // host pode vir no payload (payload.host) ou fallback para socket.id
      const host = payload && payload.host ? String(payload.host).slice(0,40) : socket.id;

      socket.join(roomName);
      console.log(`👑 ${socket.id} criou a sala ${roomName}`);
      app.locals.roomsState[roomName] = app.locals.roomsState[roomName] || { time: 0, playing: false, ts: Date.now() };

      // atualiza preview caso já tenha video no server (string path ou object youtube)
      const preview = app.locals.rooms[roomName] || null;

      // atualizar registry do lobby
      app.locals.roomInfos[roomName] = app.locals.roomInfos[roomName] || {
        name: roomName,
        owner: host,
        hasPassword: !!(payload && payload.password),
        users: io.sockets.adapter.rooms.get(roomName)?.size || 0,
        createdAt: Date.now(),
        preview
      };

      // envia video / sync / chatHistory só pro criador (mantém seu comportamento)
      if (app.locals.rooms[roomName]) socket.emit("video-ready", app.locals.rooms[roomName]);
      socket.emit("sync", app.locals.roomsState[roomName]);
      socket.emit("chat-history", app.locals.chatHistory[roomName] || []);

      // atualizar contagem e enviar updates:
      const size = io.sockets.adapter.rooms.get(roomName)?.size || 0;
      app.locals.roomInfos[roomName].users = size;
      io.in(roomName).emit("room-count", size);

      // **IMPORTANTE**: notifique o LOBBY — broadcast para todos sockets que uma sala foi criada/atualizada
      io.emit("room-created", {
        name: app.locals.roomInfos[roomName].name,
        owner: app.locals.roomInfos[roomName].owner,
        hasPassword: !!app.locals.roomInfos[roomName].hasPassword,
        users: app.locals.roomInfos[roomName].users,
        createdAt: app.locals.roomInfos[roomName].createdAt,
        preview: app.locals.roomInfos[roomName].preview || null
      });
    } catch (err) {
      console.error("Erro em create-room:", err);
    }
  });

  // join-room: join & receive current video + state + history
  socket.on("join-room", (payload, maybeAck) => {
    try {
      // payload pode ser string ou objeto { room, password, user }
      const roomName = getRoomName(payload);
      if (!roomName) {
        console.warn("join-room recebido sem room válido:", payload);
        if (typeof maybeAck === "function") maybeAck({ ok: false, error: "room inválida" });
        return;
      }
      socket.join(roomName);
      console.log(`👥 ${socket.id} entrou em ${roomName}`);

      if (app.locals.rooms[roomName]) socket.emit("video-ready", app.locals.rooms[roomName]);
      if (app.locals.roomsState[roomName]) socket.emit("sync", app.locals.roomsState[roomName]);
      socket.emit("chat-history", app.locals.chatHistory[roomName] || []);
      const size = io.sockets.adapter.rooms.get(roomName)?.size || 0;

      app.locals.roomInfos[roomName] = app.locals.roomInfos[roomName] || {
        name: roomName,
        owner: null,
        hasPassword: false,
        users: size,
        createdAt: Date.now(),
        preview: app.locals.rooms[roomName] || null
      };
      app.locals.roomInfos[roomName].users = size;

      // informe participantes da sala
      io.in(roomName).emit("room-count", size);

      // informe o lobby (outros clientes)
      io.emit("room-updated", {
        name: app.locals.roomInfos[roomName].name,
        owner: app.locals.roomInfos[roomName].owner,
        hasPassword: !!app.locals.roomInfos[roomName].hasPassword,
        users: app.locals.roomInfos[roomName].users,
        createdAt: app.locals.roomInfos[roomName].createdAt,
        preview: app.locals.roomInfos[roomName].preview || null
      });

      if (typeof maybeAck === "function") maybeAck({ ok: true });
    } catch (err) {
      console.error("Erro em join-room:", err);
      if (typeof maybeAck === "function") maybeAck({ ok: false, error: String(err) });
    }
  });

  // permite que o cliente peça a lista de salas a qualquer momento
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
  });

  // NEW: youtube event -> validate server-side then store as { youtube: id, meta } and broadcast to room
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

      // Validate/lookup metadata on server using YouTube Data API
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

      // store object so new joiners get same shape
      app.locals.rooms[room] = { youtube: id, meta };

      // update preview in registry
      app.locals.roomInfos[room] = app.locals.roomInfos[room] || {
        name: room,
        owner: null,
        hasPassword: false,
        users: io.sockets.adapter.rooms.get(room)?.size || 0,
        createdAt: Date.now(),
        preview: null
      };
      app.locals.roomInfos[room].preview = { youtube: id, meta };

      // broadcast to room
      io.to(room).emit("video-ready", { youtube: id, meta });
      io.to(room).emit("youtube", { id, room, from: socket.id, meta });

      // inform lobby about update
      io.emit("room-updated", app.locals.roomInfos[room]);

      console.log(`▶️ YouTube ${id} validado e enviado para sala ${room} por ${socket.id}`);

      if (typeof ack === 'function') ack({ ok: true, id });
    } catch (err) {
      console.error("Erro no handler 'youtube':", err);
      if (typeof ack === 'function') ack({ ok: false, error: String(err) });
    }
  });

  // control: unified control from clients -> server marks ts and broadcasts authoritative sync
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

  // chat-message with simple rate limit & sanitization
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
      const user = payload.user ? String(payload.user).slice(0, 40) : "Guest";
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

  // clear-chat (authorized only if needed - here open)
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

  // update room counts on disconnecting and clean empty rooms from roomInfos
  socket.on("disconnecting", () => {
    const rooms = Array.from(socket.rooms || []).filter(r => r !== socket.id);
    rooms.forEach(r => {
      setImmediate(() => {
        const size = io.sockets.adapter.rooms.get(r)?.size || 0;
        // atualiza users
        if (app.locals.roomInfos[r]) app.locals.roomInfos[r].users = size;
        io.in(r).emit("room-count", size);

        // se zero usuários, remova a sala do registry e notifique o lobby
        if (size === 0 && app.locals.roomInfos[r]) {
          const removed = app.locals.roomInfos[r];
          delete app.locals.roomInfos[r];
          // Notifica lobby que a sala foi removida
          io.emit("room-removed", { name: r, removedAt: Date.now(), preview: removed.preview || null });
        } else {
          // se ainda existe gente, notifique atualização
          if (app.locals.roomInfos[r]) io.emit("room-updated", app.locals.roomInfos[r]);
        }
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

// ---------- start (bind em 0.0.0.0 e log automático de IPs) ----------
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