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
const io = new Server(server);

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
    io.to(room).emit("video-ready", videoPath);
    return res.json({ success: true, video: videoPath });
  });
});

// health
app.get("/health", (req, res) => res.json({ ok: true }));

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
    // normalize axios error messages
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
  socket.on("create-room", (room) => {
    if (!room) return;
    socket.join(room);
    console.log(`👑 ${socket.id} criou a sala ${room}`);
    app.locals.roomsState[room] = app.locals.roomsState[room] || { time: 0, playing: false, ts: Date.now() };
    // if there is already a video (file or youtube object), send it
    if (app.locals.rooms[room]) socket.emit("video-ready", app.locals.rooms[room]);
    socket.emit("sync", app.locals.roomsState[room]);
    // send chat history
    socket.emit("chat-history", app.locals.chatHistory[room] || []);
    // emit count
    const size = io.sockets.adapter.rooms.get(room)?.size || 0;
    io.in(room).emit("room-count", size);
  });

  // join-room: join & receive current video + state + history
  socket.on("join-room", (room) => {
    if (!room) return;
    socket.join(room);
    console.log(`👥 ${socket.id} entrou em ${room}`);
    if (app.locals.rooms[room]) socket.emit("video-ready", app.locals.rooms[room]);
    if (app.locals.roomsState[room]) socket.emit("sync", app.locals.roomsState[room]);
    socket.emit("chat-history", app.locals.chatHistory[room] || []);
    const size = io.sockets.adapter.rooms.get(room)?.size || 0;
    io.in(room).emit("room-count", size);
  });

  // NEW: youtube event -> validate server-side then store as { youtube: id, meta } and broadcast to room
  // supports optional callback ack as second arg
  socket.on("youtube", async (payload, ack) => {
    try {
      if (!payload || !payload.room) {
        if (typeof ack === 'function') ack({ ok: false, error: "payload.room ausente" });
        return;
      }
      const room = String(payload.room);
      const rawId = (payload.id || payload.youtube || "").toString().trim();
      // Extract basic ID shape: prefer 11 chars, but be flexible and try to sanitize
      const id = rawId.length === 11 ? rawId : (rawId.split(/[?&]/)[0] || rawId);
      if (!id || id.length < 8) { // very permissive check; real validation below via API
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

      // broadcast to room
      io.to(room).emit("video-ready", { youtube: id, meta });
      // also emit a convenience 'youtube' event (your client listens to this too)
      io.to(room).emit("youtube", { id, room, from: socket.id, meta });

      console.log(`▶️ YouTube ${id} validado e enviado para sala ${room} por ${socket.id}`);

      if (typeof ack === 'function') ack({ ok: true, id });
    } catch (err) {
      console.error("Erro no handler 'youtube':", err);
      if (typeof ack === 'function') ack({ ok: false, error: String(err) });
    }
  });

  // control: unified control from clients -> server marks ts and broadcasts authoritative sync
  socket.on("control", ({ room, time, playing }) => {
    if (!room) return;
    const ts = Date.now();
    app.locals.roomsState[room] = { time: Number(time) || 0, playing: !!playing, ts };
    io.in(room).emit("sync", app.locals.roomsState[room]);
    console.log(`📡 control from ${socket.id} for ${room} => time=${time}, playing=${playing}, ts=${ts}`);
  });

  // chat-message with simple rate limit & sanitization
  socket.on("chat-message", (payload) => {
    try {
      if (!payload || !payload.room || !payload.text) return;
      const room = payload.room;
      // rate limit: max 12 messages per 10 seconds per socket
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
  socket.on("clear-chat", (room) => {
    if (!room) return;
    app.locals.chatHistory[room] = [];
    io.in(room).emit("chat-cleared");
  });

  // update room counts on disconnecting
  socket.on("disconnecting", () => {
    const rooms = Array.from(socket.rooms || []).filter(r => r !== socket.id);
    rooms.forEach(r => {
      setImmediate(() => {
        const size = io.sockets.adapter.rooms.get(r)?.size || 0;
        io.in(r).emit("room-count", size);
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