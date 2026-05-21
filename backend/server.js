const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
app.use(cors());

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

const rooms = {};

function generateRoomId() {
  let roomId;
  do {
    roomId = Math.floor(10000 + Math.random() * 90000).toString();
  } while (rooms[roomId]);
  return roomId;
}

function getPublicMembers(room) {
  return room.members.map((member) => ({
    socketId: member.socketId,
    username: member.username,
    role: member.role,
    micOn: member.micOn || false,
    deafenOn: member.deafenOn || false,
    speaking: member.speaking || false,
    cameraOn: member.cameraOn || false,
  }));
}

function closeRoom(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  io.to(roomId).emit("room-closed");

  room.members.forEach((member) => {
    const memberSocket = io.sockets.sockets.get(member.socketId);
    if (memberSocket) memberSocket.leave(roomId);
  });

  delete rooms[roomId];
}

function removeUser(socket) {
  for (const roomId in rooms) {
    const room = rooms[roomId];
    const wasHost = room.hostId === socket.id;

    room.members = room.members.filter(
      (member) => member.socketId !== socket.id
    );

    room.requests = room.requests.filter((req) => req.socketId !== socket.id);

    socket.to(roomId).emit("user-left-voice", { socketId: socket.id });
    socket.to(roomId).emit("screen-share-stopped", { socketId: socket.id });
    socket.to(roomId).emit("camera-stopped", { socketId: socket.id });

    if (wasHost) {
      closeRoom(roomId);
      continue;
    }

    io.to(roomId).emit("members-updated", getPublicMembers(room));
  }
}

io.on("connection", (socket) => {
  console.log("Connected:", socket.id);

  socket.on("create-room", ({ username }) => {
    if (!username) return;

    const roomId = generateRoomId();

    rooms[roomId] = {
      hostId: socket.id,
      members: [
        {
          socketId: socket.id,
          username,
          role: "Host",
          micOn: false,
          deafenOn: false,
          speaking: false,
          cameraOn: false,
        },
      ],
      requests: [],
      messages: [],
    };

    socket.join(roomId);

    socket.emit("room-created", {
      roomId,
      members: getPublicMembers(rooms[roomId]),
    });
  });

  socket.on("join-request", ({ roomId, username }) => {
    const room = rooms[roomId];

    if (!room) {
      socket.emit("join-error", "Room not found");
      return;
    }

    const request = {
      socketId: socket.id,
      username,
      roomId,
    };

    room.requests.push(request);

    io.to(room.hostId).emit("incoming-request", request);
    socket.emit("request-sent");
  });

  socket.on("approve-request", ({ roomId, socketId, username }) => {
    const room = rooms[roomId];
    if (!room) return;

    room.requests = room.requests.filter((req) => req.socketId !== socketId);

    room.members.push({
      socketId,
      username,
      role: "Member",
      micOn: false,
      deafenOn: false,
      speaking: false,
      cameraOn: false,
    });

    const memberSocket = io.sockets.sockets.get(socketId);
    if (memberSocket) memberSocket.join(roomId);

    io.to(socketId).emit("request-approved", {
      roomId,
      members: getPublicMembers(room),
      messages: room.messages,
    });

    io.to(roomId).emit("members-updated", getPublicMembers(room));
  });

  socket.on("leave-room", ({ roomId }) => {
    const room = rooms[roomId];

    if (!room) {
      socket.emit("left-room");
      return;
    }

    const wasHost = room.hostId === socket.id;

    room.members = room.members.filter(
      (member) => member.socketId !== socket.id
    );

    room.requests = room.requests.filter((req) => req.socketId !== socket.id);

    socket.leave(roomId);

    socket.to(roomId).emit("user-left-voice", { socketId: socket.id });
    socket.to(roomId).emit("screen-share-stopped", { socketId: socket.id });
    socket.to(roomId).emit("camera-stopped", { socketId: socket.id });

    if (wasHost) {
      closeRoom(roomId);
      socket.emit("left-room");
      return;
    }

    io.to(roomId).emit("members-updated", getPublicMembers(room));
    socket.emit("left-room");
  });

  socket.on("member-status", ({ roomId, micOn, deafenOn, cameraOn }) => {
    const room = rooms[roomId];
    if (!room) return;

    const member = room.members.find((m) => m.socketId === socket.id);
    if (!member) return;

    member.micOn = micOn;
    member.deafenOn = deafenOn;

    if (typeof cameraOn === "boolean") {
      member.cameraOn = cameraOn;
    }

    if (!micOn) member.speaking = false;

    io.to(roomId).emit("members-updated", getPublicMembers(room));
  });

  socket.on("speaking-status", ({ roomId, speaking }) => {
    const room = rooms[roomId];
    if (!room) return;

    const member = room.members.find((m) => m.socketId === socket.id);
    if (!member) return;

    member.speaking = speaking;

    io.to(roomId).emit("members-updated", getPublicMembers(room));
  });

  socket.on("voice-ready", ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) return;

    const users = room.members
      .filter((member) => member.socketId !== socket.id)
      .map((member) => ({
        socketId: member.socketId,
        username: member.username,
      }));

    socket.emit("voice-users", users);

    socket.to(roomId).emit("new-voice-user", {
      socketId: socket.id,
    });
  });

  socket.on("voice-offer", ({ to, offer }) => {
    io.to(to).emit("voice-offer", {
      from: socket.id,
      offer,
    });
  });

  socket.on("voice-answer", ({ to, answer }) => {
    io.to(to).emit("voice-answer", {
      from: socket.id,
      answer,
    });
  });

  socket.on("ice-candidate", ({ to, candidate }) => {
    io.to(to).emit("ice-candidate", {
      from: socket.id,
      candidate,
    });
  });

  socket.on("screen-share-started", ({ roomId }) => {
    socket.to(roomId).emit("screen-share-started", {
      socketId: socket.id,
    });
  });

  socket.on("screen-share-stopped", ({ roomId }) => {
    socket.to(roomId).emit("screen-share-stopped", {
      socketId: socket.id,
    });
  });

  socket.on("camera-started", ({ roomId }) => {
    socket.to(roomId).emit("camera-started", {
      socketId: socket.id,
    });
  });

  socket.on("camera-stopped", ({ roomId }) => {
    socket.to(roomId).emit("camera-stopped", {
      socketId: socket.id,
    });
  });

  socket.on("send-chat-message", ({ roomId, text, username }) => {
    const room = rooms[roomId];
    if (!room) return;

    const message = {
      id: `${Date.now()}-${socket.id}`,
      socketId: socket.id,
      username,
      text,
      time: new Date().toLocaleTimeString(),
    };

    room.messages.push(message);

    if (room.messages.length > 100) {
      room.messages.shift();
    }

    io.to(roomId).emit("chat-message", message);
  });

  socket.on("host-set-mic", ({ roomId, targetSocketId, micOn }) => {
    const room = rooms[roomId];
    if (!room) return;
    if (room.hostId !== socket.id) return;

    io.to(targetSocketId).emit("force-mic-state", { micOn });
  });

  socket.on("host-set-deafen", ({ roomId, targetSocketId, deafenOn }) => {
    const room = rooms[roomId];
    if (!room) return;
    if (room.hostId !== socket.id) return;

    io.to(targetSocketId).emit("force-deafen-state", { deafenOn });
  });

  socket.on("host-kick-member", ({ roomId, targetSocketId }) => {
    const room = rooms[roomId];
    if (!room) return;
    if (room.hostId !== socket.id) return;

    const targetSocket = io.sockets.sockets.get(targetSocketId);

    if (targetSocket) {
      targetSocket.leave(roomId);
      io.to(targetSocketId).emit("kicked-from-room");
    }

    room.members = room.members.filter(
      (member) => member.socketId !== targetSocketId
    );

    io.to(roomId).emit("members-updated", getPublicMembers(room));

    io.to(roomId).emit("user-left-voice", {
      socketId: targetSocketId,
    });

    io.to(roomId).emit("camera-stopped", {
      socketId: targetSocketId,
    });

    io.to(roomId).emit("screen-share-stopped", {
      socketId: targetSocketId,
    });
  });

  socket.on("disconnect", () => {
    removeUser(socket);
    console.log("Disconnected:", socket.id);
  });
});

app.get("/", (req, res) => {
  res.send("EchoRoom backend running...");
});

const PORT = process.env.PORT || 5000;

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});