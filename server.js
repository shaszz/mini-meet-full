// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;

// serve static client files
app.use(express.static(path.join(__dirname, 'public')));

// optional: simple homepage redirect to client
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// Socket.io with permissive CORS for testing (adjust origin for production)
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// rooms map for tracking participants
const rooms = new Map();

io.on('connection', (socket) => {
  console.log('[io] connected', socket.id);

  socket.on('join-room', (roomId) => {
    try {
      if (!roomId) return socket.emit('error-msg', 'missing-room-id');
      socket.join(roomId);
      socket.data.roomId = roomId;

      if (!rooms.has(roomId)) rooms.set(roomId, new Set());
      const set = rooms.get(roomId);

      const otherUsers = Array.from(set);
      socket.emit('existing-users', otherUsers);

      set.add(socket.id);
      console.log(`[room:${roomId}] ${socket.id} joined — total: ${set.size}`);

      socket.to(roomId).emit('user-joined', socket.id);
    } catch (err) {
      console.error('join-room error', err);
    }
  });

  // WebRTC signaling
  socket.on('offer', (payload) => {
    if (payload && payload.target) io.to(payload.target).emit('offer', payload);
  });
  socket.on('answer', (payload) => {
    if (payload && payload.target) io.to(payload.target).emit('answer', payload);
  });
  socket.on('ice-candidate', (payload) => {
    if (payload && payload.target) io.to(payload.target).emit('ice-candidate', payload);
  });

  // Chat relay
  socket.on('send-chat', (text) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    io.to(roomId).emit('chat', { sender: socket.id, text, ts: Date.now() });
  });

  // AUDIO CHUNK relay: receives audio-chunk from any publisher (python client) and forwards to other sockets in the room
  // Expected payload: { room: <roomId>, data: <base64 string>, sample_rate: <number>, channels: <number>, sender: <optional> }
  socket.on('audio-chunk', (payload) => {
    try {
      const roomId = payload.room || socket.data.roomId;
      if (!roomId) return;
      // include sender id if not provided
      const sender = payload.sender || socket.id;
      const out = {
        data: payload.data,
        sample_rate: payload.sample_rate || 16000,
        channels: payload.channels || 1,
        sender
      };
      // send to all others in room
      socket.to(roomId).emit('audio-chunk', out);
    } catch (err) {
      console.error('audio-chunk error', err);
    }
  });

  socket.on('leave-room', () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    socket.leave(roomId);
    const set = rooms.get(roomId);
    if (set) {
      set.delete(socket.id);
      socket.to(roomId).emit('user-left', socket.id);
      if (set.size === 0) rooms.delete(roomId);
    }
    delete socket.data.roomId;
  });

  socket.on('disconnect', (reason) => {
    const roomId = socket.data.roomId;
    console.log('[io] disconnect', socket.id, reason, 'room:', roomId);
    if (roomId && rooms.has(roomId)) {
      const set = rooms.get(roomId);
      set.delete(socket.id);
      socket.to(roomId).emit('user-left', socket.id);
      if (set.size === 0) rooms.delete(roomId);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
