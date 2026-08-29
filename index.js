const { createServer } = require("node:http");
const express = require("express");
const app = express();
const server = createServer(app);
const path = require("path");
const fs = require("fs");
const os = require("os");
const { Server } = require("socket.io");

const io = new Server(server, {
  maxHttpBufferSize: 1e8 // 100MB
});

const DB_FILE = path.join(__dirname, "chat_database.json");

// تحميل الأرشيف القديم من القرص عند بدء التشغيل
let roomHistory = {};
if (fs.existsSync(DB_FILE)) {
  try {
    roomHistory = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
  } catch (e) {
    console.error("خطأ في قراءة ملف قاعدة البيانات:", e);
    roomHistory = {};
  }
}

// حفظ السجل في JSON
function saveDatabase() {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(roomHistory, null, 2), "utf8");
  } catch (e) {
    console.error("خطأ أثناء حفظ المحادثات:", e);
  }
}

const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN;
const telegramChatId = process.env.TELEGRAM_CHAT_ID;
const telegramLoggingEnabled = Boolean(telegramBotToken && telegramChatId);
const telegramRoomQueues = new Map();
const telegramRequestTimeoutMs = 15000;

function parseDataUri(fileData) {
  if (typeof fileData !== "string") return null;
  const match = fileData.match(/^data:([^;,]+)(?:;[^,]*)?,(.*)$/s);
  if (!match) return null;
  const mimeType = match[1];
  const encodedData = match[2];
  const buffer = fileData.includes(";base64,")
    ? Buffer.from(encodedData, "base64")
    : Buffer.from(decodeURIComponent(encodedData));
  return { mimeType, buffer };
}

function extensionForMimeType(mimeType) {
  const extension = mimeType.split("/")[1]?.split("+")[0];
  return extension || "bin";
}

async function telegramApiRequest(method, body) {
  if (!telegramLoggingEnabled) return;
  const response = await fetch(
    `https://api.telegram.org/bot${telegramBotToken}/${method}`,
    {
      method: "POST",
      headers: body instanceof FormData ? undefined : { "content-type": "application/json" },
      body: body instanceof FormData ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(telegramRequestTimeoutMs)
    }
  );
  if (!response.ok) throw new Error(`Telegram ${method} failed`);
  const result = await response.json();
  if (!result.ok) throw new Error(`Telegram ${method} rejected`);
}

function telegramMessageHeader(roomId, userId, username, time) {
  const nameStr = username ? `${username} (${userId})` : userId;
  return `Room: ${roomId}\nUser: ${nameStr}\nTime: ${time || "unknown"}`;
}

async function sendTelegramText({ roomId, userId, username, time, msg }) {
  const text = `${telegramMessageHeader(roomId, userId, username, time)}\n\n${msg}`;
  const chunks = text.match(/[\s\S]{1,4000}/g) || [text];
  for (const chunk of chunks) {
    await telegramApiRequest("sendMessage", {
      chat_id: telegramChatId,
      text: chunk,
      disable_web_page_preview: true
    });
  }
}

async function sendTelegramMedia({ roomId, userId, username, time, fileData, fileType }) {
  const header = telegramMessageHeader(roomId, userId, username, time);
  const parsedData = parseDataUri(fileData);

  if (!parsedData) {
    await telegramApiRequest("sendMessage", {
      chat_id: telegramChatId,
      text: `${header}\n\nMedia (${fileType}): ${fileData}`,
      disable_web_page_preview: false
    });
    return;
  }

  const fileExtension = extensionForMimeType(parsedData.mimeType);
  const fileName = `room-${roomId}-${Date.now()}.${fileExtension}`;
  const form = new FormData();
  const isSmallImage = fileType === "image" && parsedData.buffer.length <= 10 * 1024 * 1024;
  const telegramMethod = isSmallImage ? "sendPhoto" : "sendDocument";
  const telegramField = isSmallImage ? "photo" : "document";

  form.append("chat_id", telegramChatId);
  form.append("caption", `${header}\n\nMedia: ${fileType}`.slice(0, 1024));
  form.append(
    telegramField,
    new Blob([parsedData.buffer], { type: parsedData.mimeType }),
    fileName
  );

  await telegramApiRequest(telegramMethod, form);
}

async function forwardToTelegram(payload) {
  if (!telegramLoggingEnabled) return;
  if (payload.type === "text") {
    await sendTelegramText(payload);
  } else if (payload.type === "media") {
    await sendTelegramMedia(payload);
  }
}

function enqueueTelegramTask(roomId, task) {
  const previousTask = telegramRoomQueues.get(roomId) || Promise.resolve();
  const currentTask = previousTask
    .catch(() => {})
    .then(async () => {
      try {
        await task();
      } catch (error) {
        console.error(`Telegram logging failed:`, error.message);
      }
    });

  telegramRoomQueues.set(roomId, currentTask);
  currentTask.finally(() => {
    if (telegramRoomQueues.get(roomId) === currentTask) {
      telegramRoomQueues.delete(roomId);
    }
  }).catch(() => {});

  return currentTask;
}

const desktopPath = path.join(os.homedir(), "Desktop");
const archiveFolder = path.join(desktopPath, "Admin_Chat_Archive");

if (!fs.existsSync(archiveFolder)) {
  fs.mkdirSync(archiveFolder, { recursive: true });
}

function logMessageToFile(roomId, text) {
  const roomLogFile = path.join(archiveFolder, `Room_${roomId}_History.txt`);
  const timestamp = new Date().toLocaleString();
  fs.appendFile(roomLogFile, `[${timestamp}] ${text}\n`, (err) => {
    if (err) console.error("خطأ في حفظ النص:", err);
  });
}

function saveMediaToFile(roomId, userId, username, fileData, fileType) {
  try {
    const mediaFolder = path.join(archiveFolder, `Room_${roomId}_Media`);
    if (!fs.existsSync(mediaFolder)) {
      fs.mkdirSync(mediaFolder, { recursive: true });
    }

    const matches = fileData.match(/^data:(.+);base64,(.+)$/);
    if (!matches) return;

    const ext = matches[1].split("/")[1].split("+")[0];
    const buffer = Buffer.from(matches[2], "base64");
    const fileName = `${Date.now()}_${userId}_${fileType}.${ext}`;
    const filePath = path.join(mediaFolder, fileName);

    fs.writeFile(filePath, buffer, (err) => {
      if (err) console.error("خطأ في حفظ الملف:", err);
    });

    const displayName = username ? `${username} (${userId})` : userId;
    logMessageToFile(roomId, `[ميديا - ${fileType}] قام ${displayName} بإرسال ملف: ${fileName}`);
  } catch (e) {
    console.error("خطأ الميديا:", e);
  }
}

app.use(express.static(path.resolve("./Public")));

app.get("/", (req, res) => res.sendFile(path.resolve("./Public/index.html")));
app.get("/room.html", (req, res) => res.sendFile(path.resolve("./Public/room.html")));

const roomsSettings = {}; 

io.on("connection", (socket) => {
  socket.on("join-room", ({ roomId, userId, maxUsers, isHost }) => {
    if (!roomId || !userId) return;

    if (!roomsSettings[roomId]) {
      roomsSettings[roomId] = {
        maxUsers: parseInt(maxUsers) || 24,
        hostUserId: isHost ? userId : null
      };
    }

    if (isHost && !roomsSettings[roomId].hostUserId) {
      roomsSettings[roomId].hostUserId = userId;
    }

    const room = io.sockets.adapter.rooms.get(roomId);
    const currentUsersCount = room ? room.size : 0;
    const isAlreadyConnected = room && socket.rooms.has(roomId);

    if (!isAlreadyConnected && currentUsersCount >= roomsSettings[roomId].maxUsers) {
      socket.emit("room-full", { message: "عذراً، الغرفة ممتلئة ولا يمكنك الانضمام الآن." });
      return;
    }

    socket.join(roomId);
    socket.userId = userId;
    socket.roomId = roomId;

    if (!roomHistory[roomId]) roomHistory[roomId] = [];

    const isOwner = roomsSettings[roomId].hostUserId === userId;

    socket.emit("room-info", {
      maxUsers: roomsSettings[roomId].maxUsers,
      isHost: isOwner
    });

    // إرسال السجل كاملاً مع تفاصيل القراءة والتفاعلات
    socket.emit("load-history", roomHistory[roomId]);
  });

  socket.on("update-room-capacity", ({ roomId, newMax }) => {
    if (roomsSettings[roomId] && roomsSettings[roomId].hostUserId === socket.userId) {
      roomsSettings[roomId].maxUsers = parseInt(newMax);
      io.to(roomId).emit("capacity-updated", { maxUsers: roomsSettings[roomId].maxUsers });
    }
  });

  socket.on("user-typing", ({ roomId, status }) => {
    socket.to(roomId).emit("user-typing-status", { id: socket.id, status });
  });

  socket.on("user-message", async ({ roomId, msg, msgId, userId, username, time, replyTo }) => {
    const messageData = { 
      type: "text", 
      msg, 
      msgId: msgId || ("msg-" + Date.now()), 
      userId, 
      username, 
      time, 
      replyTo: replyTo || null,
      reactions: [],
      readBy: [userId]
    };

    await enqueueTelegramTask(roomId, () =>
      forwardToTelegram({ type: "text", roomId, msg, msgId: messageData.msgId, userId, username, time })
    );

    if (!roomHistory[roomId]) roomHistory[roomId] = [];
    roomHistory[roomId].push(messageData);
    saveDatabase();

    const displayName = username ? `${username} (${userId})` : userId;
    logMessageToFile(roomId, `${displayName} (${time}): ${msg}`);

    io.to(roomId).emit("broadcast-message", messageData);
  });

  socket.on("send-media", async ({ roomId, msgId, fileData, fileType, userId, username, time, replyTo }) => {
    const mediaData = { 
      type: "media", 
      msgId: msgId || ("msg-" + Date.now()), 
      fileData, 
      fileType, 
      userId, 
      username, 
      time, 
      replyTo: replyTo || null,
      reactions: [],
      readBy: [userId]
    };

    await enqueueTelegramTask(roomId, () =>
      forwardToTelegram({ type: "media", roomId, fileData, fileType, userId, username, time })
    );

    if (!roomHistory[roomId]) roomHistory[roomId] = [];
    roomHistory[roomId].push(mediaData);
    saveDatabase();

    saveMediaToFile(roomId, userId, username, fileData, fileType);

    io.to(roomId).emit("receive-media", mediaData);
  });

  socket.on("mark-as-read", ({ roomId, messageId, userId }) => {
    if (!roomHistory[roomId]) return;
    const msg = roomHistory[roomId].find(m => m.msgId === messageId);
    if (msg) {
      if (!msg.readBy) msg.readBy = [];
      if (userId && !msg.readBy.includes(userId)) {
        msg.readBy.push(userId);
        saveDatabase();
      }
      io.to(roomId).emit("message-read-status", { messageId, readBy: msg.readBy });
    }
  });

  socket.on("send-reaction", ({ roomId, msgId, emoji, userId }) => {
    if (!roomHistory[roomId]) return;
    const msg = roomHistory[roomId].find(m => m.msgId === msgId);
    if (msg) {
      if (!msg.reactions) msg.reactions = [];
      msg.reactions.push({ emoji, userId });
      saveDatabase();
      io.to(roomId).emit("receive-reaction", { msgId, emoji, userId });
    }
  });

  socket.on("clear-room-history", async (roomId) => {
    await waitForTelegramQueue(roomId);
    roomHistory[roomId] = [];
    saveDatabase();
    logMessageToFile(roomId, `=== قام أحد المستخدمين بمسح الشاشة ===`);
    io.to(roomId).emit("chat-cleared");
  });

  socket.on("disconnect", () => {});
});

const PORT = process.env.PORT || 9000;
server.listen(PORT, () => {
  console.log(`Server Started on port ${PORT}`);
});