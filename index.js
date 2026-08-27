const { createServer } = require("node:http");
const express = require("express");
const app = express();
const server = createServer(app);
const path = require("path");
const fs = require("fs");
const os = require("os");
const { Server } = require("socket.io");

const io = new Server(server, {
  maxHttpBufferSize: 1e8 // زيادة الحجم للملفات والبصمات (100MB)
});

// إعداد مسار مجلد الأرشيف الخاص بك على سطح المكتب
const desktopPath = path.join(os.homedir(), "Desktop");
const archiveFolder = path.join(desktopPath, "Admin_Chat_Archive");

if (!fs.existsSync(archiveFolder)) {
  fs.mkdirSync(archiveFolder, { recursive: true });
}

// دالة لحفظ النصوص في ملف خاص بكل غرفة
function logMessageToFile(roomId, text) {
  const roomLogFile = path.join(archiveFolder, `Room_${roomId}_History.txt`);
  const timestamp = new Date().toLocaleString();
  const logLine = `[${timestamp}] ${text}\n`;

  fs.appendFile(roomLogFile, logLine, (err) => {
    if (err) console.error("خطأ في حفظ النص:", err);
  });
}

// دالة لحفظ الوسائط (صور، فيديو، صوت، ملصقات) داخل مجلد الغرفة
function saveMediaToFile(roomId, userId, fileData, fileType) {
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

    logMessageToFile(roomId, `[ميديا - ${fileType}] قام ${userId} بإرسال ملف: ${fileName}`);
  } catch (e) {
    console.error("خطأ أثناء معالجة الميديا:", e);
  }
}

app.use(express.static(path.resolve("./Public")));

app.get("/", (req, res) => {
  res.sendFile(path.resolve("./Public/index.html"));
});

app.get("/room.html", (req, res) => {
  res.sendFile(path.resolve("./Public/room.html"));
});

// ذاكرة حفظ سجل المحادثات لكل غرفة بالسيرفر
const roomHistory = {};

io.on("connection", (socket) => {
  console.log("A user connected:", socket.id);

  // الانضمام للغرفة واسترجاع السجل
  socket.on("join-room", ({ roomId, userId }) => {
    socket.join(roomId);
    socket.userId = userId;
    socket.roomId = roomId;

    if (!roomHistory[roomId]) {
      roomHistory[roomId] = [];
    }

    // إرسال كامل الأرشيف للمستخدم فور دخوله
    socket.emit("load-history", roomHistory[roomId]);
  });

  socket.on("user-typing", ({ roomId, status }) => {
    socket.to(roomId).emit("user-typing-status", { id: socket.id, status });
  });

  // استقبال الرسائل النصية وحفظها في الذاكرة + سطح المكتب
  socket.on("user-message", ({ roomId, msg, msgId, userId, time }) => {
    const messageData = { type: "text", msg, msgId, userId, time };

    if (!roomHistory[roomId]) roomHistory[roomId] = [];
    roomHistory[roomId].push(messageData);

    // حفظ في الأرشيف الدائم على سطح المكتب
    logMessageToFile(roomId, `${userId} (${time}): ${msg}`);

    io.to(roomId).emit("broadcast-message", messageData);
  });

  socket.on("mark-as-read", ({ roomId, messageId }) => {
    io.to(roomId).emit("message-read-status", { messageId });
  });

  // استقبال الوسائط وحفظها في الذاكرة + سطح المكتب
  socket.on("send-media", ({ roomId, fileData, fileType, userId, time }) => {
    const mediaData = { type: "media", fileData, fileType, userId, time };

    if (!roomHistory[roomId]) roomHistory[roomId] = [];
    roomHistory[roomId].push(mediaData);

    // حفظ الوسائط في ملفات حقيقية على سطح المكتب
    saveMediaToFile(roomId, userId, fileData, fileType);

    io.to(roomId).emit("receive-media", mediaData);
  });

  // زر مسح المحادثة من شاشات المستخدمين فقط (يبقى الملف في سطح المكتب كما هو)
  socket.on("clear-room-history", (roomId) => {
    roomHistory[roomId] = [];

    // إرسال تدوين في الملف يوضح أن المحادثة مٌسحت من الواجهة
    logMessageToFile(roomId, `=== قام أحد المستخدمين بمسح الشاشة ===`);

    io.to(roomId).emit("chat-cleared");
  });

  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id);
  });
});

const PORT = process.env.PORT || 9000;
server.listen(PORT, () => {
  console.log(`Server Started on port ${PORT}`);
  console.log(`تم تفعيل حفظ الأرشيف في سطح المكتب: ${archiveFolder}`);
});