const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const db = require('./db');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  maxHttpBufferSize: 5e6 // 5MB for file sharing
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── REST API ───────────────────────────────────────────────

// Register
app.post('/api/register', (req, res) => {
  const { username, displayName, pin } = req.body;
  if (!username || !displayName || !pin) {
    return res.status(400).json({ error: 'All fields required' });
  }
  try {
    const user = db.createUser(username.toLowerCase().trim(), displayName.trim(), pin);
    res.json({ success: true, user: { id: user.id, username: user.username, displayName: user.displayName } });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Login
app.post('/api/login', (req, res) => {
  const { username, pin } = req.body;
  if (!username || !pin) {
    return res.status(400).json({ error: 'Username and PIN required' });
  }
  const user = db.verifyUser(username.toLowerCase().trim(), pin);
  if (!user) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  res.json({ success: true, user: { id: user.id, username: user.username, displayName: user.displayName } });
});

// Get all users (for contacts)
app.get('/api/users', (req, res) => {
  const users = db.getAllUsers();
  res.json(users.map(u => ({ id: u.id, username: u.username, displayName: u.displayName, avatar: u.avatar })));
});

// Get message history between two users
app.get('/api/messages/:userId1/:userId2', (req, res) => {
  const { userId1, userId2 } = req.params;
  const limit = parseInt(req.query.limit) || 100;
  const before = req.query.before || null;
  const messages = db.getMessages(parseInt(userId1), parseInt(userId2), limit, before);
  res.json(messages);
});

// Catch-all: serve index.html for SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── SOCKET.IO ──────────────────────────────────────────────

// Track online users: { oderedUserId: socketId }
const onlineUsers = new Map();

io.on('connection', (socket) => {
  console.log(`[Socket] Connected: ${socket.id}`);

  // User comes online
  socket.on('user:online', (userId) => {
    // Normalize to number to avoid type mismatch
    const uid = Number(userId);
    onlineUsers.set(uid, socket.id);
    socket.userId = uid;
    console.log(`[Online] User ${uid} → socket ${socket.id} | Online users: [${Array.from(onlineUsers.keys()).join(', ')}]`);
    // Broadcast online status
    io.emit('user:status', { userId: uid, online: true });
    // Send current online users to the newly connected user
    const onlineList = Array.from(onlineUsers.keys());
    socket.emit('users:online', onlineList);
  });

  // Text message
  socket.on('message:send', (data) => {
    const { fromUserId, toUserId, content, type = 'text' } = data;
    const message = db.saveMessage(fromUserId, toUserId, content, type);
    
    // Send to recipient if online
    const recipientSocket = onlineUsers.get(Number(toUserId));
    if (recipientSocket) {
      io.to(recipientSocket).emit('message:receive', message);
    }
    // Confirm to sender
    socket.emit('message:sent', message);
  });

  // Typing indicator
  socket.on('typing:start', ({ fromUserId, toUserId }) => {
    const recipientSocket = onlineUsers.get(Number(toUserId));
    if (recipientSocket) {
      io.to(recipientSocket).emit('typing:indicator', { userId: fromUserId, typing: true });
    }
  });

  socket.on('typing:stop', ({ fromUserId, toUserId }) => {
    const recipientSocket = onlineUsers.get(Number(toUserId));
    if (recipientSocket) {
      io.to(recipientSocket).emit('typing:indicator', { userId: fromUserId, typing: false });
    }
  });

  // Message read receipt
  socket.on('message:read', ({ messageId, readByUserId, fromUserId }) => {
    db.markAsRead(messageId);
    const senderSocket = onlineUsers.get(Number(fromUserId));
    if (senderSocket) {
      io.to(senderSocket).emit('message:read', { messageId, readByUserId });
    }
  });

  // ─── WebRTC Signaling ────────────────────────────────────

  // Call initiation
  socket.on('call:initiate', ({ fromUserId, toUserId, callType }) => {
    const toId = Number(toUserId);
    console.log(`[Call] Initiate: ${fromUserId} → ${toId} (${callType})`);
    console.log(`[Call] Online users: ${JSON.stringify(Array.from(onlineUsers.entries()))}`);
    const recipientSocket = onlineUsers.get(toId);
    if (recipientSocket) {
      console.log(`[Call] Forwarding to socket ${recipientSocket}`);
      io.to(recipientSocket).emit('call:incoming', { fromUserId: Number(fromUserId), callType });
    } else {
      console.log(`[Call] User ${toId} NOT online!`);
      socket.emit('call:unavailable', { toUserId: toId });
    }
  });

  // Call accepted
  socket.on('call:accept', ({ fromUserId, toUserId }) => {
    const toId = Number(toUserId);
    console.log(`[Call] Accept: ${fromUserId} accepted call from ${toId}`);
    const callerSocket = onlineUsers.get(toId);
    if (callerSocket) {
      console.log(`[Call] Notifying caller socket ${callerSocket}`);
      io.to(callerSocket).emit('call:accepted', { fromUserId: Number(fromUserId) });
    } else {
      console.log(`[Call] Caller ${toId} no longer online!`);
    }
  });

  // Call rejected
  socket.on('call:reject', ({ fromUserId, toUserId }) => {
    const callerSocket = onlineUsers.get(Number(toUserId));
    if (callerSocket) {
      io.to(callerSocket).emit('call:rejected', { fromUserId: Number(fromUserId) });
    }
  });

  // WebRTC offer
  socket.on('webrtc:offer', ({ toUserId, offer }) => {
    const toId = Number(toUserId);
    console.log(`[WebRTC] Offer from user ${socket.userId} → user ${toId}`);
    const recipientSocket = onlineUsers.get(toId);
    if (recipientSocket) {
      console.log(`[WebRTC] Forwarding offer to socket ${recipientSocket}`);
      io.to(recipientSocket).emit('webrtc:offer', { fromUserId: socket.userId, offer });
    } else {
      console.log(`[WebRTC] Recipient ${toId} not found in online users!`);
    }
  });

  // WebRTC answer
  socket.on('webrtc:answer', ({ toUserId, answer }) => {
    const toId = Number(toUserId);
    console.log(`[WebRTC] Answer from user ${socket.userId} → user ${toId}`);
    const recipientSocket = onlineUsers.get(toId);
    if (recipientSocket) {
      io.to(recipientSocket).emit('webrtc:answer', { fromUserId: socket.userId, answer });
    }
  });

  // ICE candidate
  socket.on('webrtc:ice-candidate', ({ toUserId, candidate }) => {
    const recipientSocket = onlineUsers.get(Number(toUserId));
    if (recipientSocket) {
      io.to(recipientSocket).emit('webrtc:ice-candidate', { fromUserId: socket.userId, candidate });
    }
  });

  // Call ended
  socket.on('call:end', ({ toUserId }) => {
    console.log(`[Call] End: user ${socket.userId} ended call with ${toUserId}`);
    const recipientSocket = onlineUsers.get(Number(toUserId));
    if (recipientSocket) {
      io.to(recipientSocket).emit('call:ended', { fromUserId: socket.userId });
    }
  });

  // Disconnect
  socket.on('disconnect', () => {
    if (socket.userId != null) {
      onlineUsers.delete(socket.userId);
      io.emit('user:status', { userId: socket.userId, online: false });
      console.log(`[Offline] User ${socket.userId} disconnected (${socket.id})`);
    }
  });
});

// ─── START ──────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Igor Chat running on http://localhost:${PORT}`);
});
