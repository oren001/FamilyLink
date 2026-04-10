const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

// ─── Simple JSON File Database ──────────────────────────

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

// Ensure data directory exists
fs.mkdirSync(DATA_DIR, { recursive: true });

// Load or initialize database
let db = { users: [], messages: [], nextUserId: 1, nextMessageId: 1 };

if (fs.existsSync(DB_FILE)) {
  try {
    db = JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
  } catch (e) {
    console.error('Failed to load DB, starting fresh:', e.message);
  }
}

// Save database to disk (debounced)
let saveTimer = null;
function save() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
    } catch (e) {
      console.error('Failed to save DB:', e.message);
    }
  }, 500);
}

// Force save on exit
process.on('exit', () => {
  try { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); } catch (e) {}
});
process.on('SIGINT', () => { process.exit(); });
process.on('SIGTERM', () => { process.exit(); });

// ─── User Functions ─────────────────────────────────────

function createUser(username, displayName, pin) {
  const existing = db.users.find(u => u.username === username);
  if (existing) throw new Error('Username already taken');

  const pinHash = bcrypt.hashSync(pin, 10);
  const user = {
    id: db.nextUserId++,
    username,
    displayName,
    pinHash,
    avatar: null,
    createdAt: new Date().toISOString()
  };
  db.users.push(user);
  save();
  return { id: user.id, username: user.username, displayName: user.displayName };
}

function verifyUser(username, pin) {
  const user = db.users.find(u => u.username === username);
  if (!user) return null;
  if (!bcrypt.compareSync(pin, user.pinHash)) return null;
  return { id: user.id, username: user.username, displayName: user.displayName };
}

function getAllUsers() {
  return db.users.map(u => ({
    id: u.id,
    username: u.username,
    displayName: u.displayName,
    avatar: u.avatar
  }));
}

function getUserById(id) {
  const user = db.users.find(u => u.id === id);
  if (!user) return null;
  return { id: user.id, username: user.username, displayName: user.displayName, avatar: user.avatar };
}

// ─── Message Functions ──────────────────────────────────

function saveMessage(fromUserId, toUserId, content, type = 'text') {
  const message = {
    id: db.nextMessageId++,
    fromUserId,
    toUserId,
    content,
    type,
    read: 0,
    createdAt: new Date().toISOString()
  };
  db.messages.push(message);
  save();
  return message;
}

function getMessages(userId1, userId2, limit = 100, before = null) {
  let msgs = db.messages.filter(m =>
    (m.fromUserId === userId1 && m.toUserId === userId2) ||
    (m.fromUserId === userId2 && m.toUserId === userId1)
  );

  if (before) {
    msgs = msgs.filter(m => m.createdAt < before);
  }

  // Sort by date ascending, take last N
  msgs.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return msgs.slice(-limit);
}

function markAsRead(messageId) {
  const msg = db.messages.find(m => m.id === messageId);
  if (msg) {
    msg.read = 1;
    save();
  }
}

function getUnreadCount(toUserId, fromUserId) {
  return db.messages.filter(m => m.toUserId === toUserId && m.fromUserId === fromUserId && !m.read).length;
}

module.exports = {
  createUser,
  verifyUser,
  getAllUsers,
  getUserById,
  saveMessage,
  getMessages,
  markAsRead,
  getUnreadCount
};
