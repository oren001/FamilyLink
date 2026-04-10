/* ═══════════════════════════════════════════════════════
   FamilyLink — Client Application (Firestore Version)
   ═══════════════════════════════════════════════════════ */

(function() {
  'use strict';

  // ─── PWA Service Worker ──────────────────────────────
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('service-worker.js')
        .then(reg => console.log('ServiceWorker registered'))
        .catch(err => console.log('ServiceWorker failed', err));
    });
  }

  // ─── PWA Install Prompt ──────────────────────────────
  let deferredPrompt;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    const installBtn = document.querySelector('#pwa-install-btn');
    if (installBtn) {
      installBtn.classList.remove('hidden');
      installBtn.addEventListener('click', async () => {
        installBtn.classList.add('hidden');
        if (deferredPrompt) {
          deferredPrompt.prompt();
          const { outcome } = await deferredPrompt.userChoice;
          console.log(`User response to install prompt: ${outcome}`);
          deferredPrompt = null;
        }
      });
    }
  });

  // ─── Firebase Config ──────────────────────────────────
  const firebaseConfig = {
    apiKey: "AIzaSyCcnpQDPsQptHdZKHupXOZNqNbO1JOD1Ss",
    authDomain: "general-4686c.firebaseapp.com",
    projectId: "general-4686c",
    storageBucket: "general-4686c.firebasestorage.app",
    messagingSenderId: "810223700186",
    appId: "1:810223700186:web:7eeeac4b4e0f921cd7fde3"
  };

  firebase.initializeApp(firebaseConfig);
  const firestore = firebase.firestore();
  const storage = firebase.storage();

  // ─── State ────────────────────────────────────────────

  let currentUser = null;
  let activeChat = null;
  let contacts = [];
  let onlineUsers = new Set();
  let typingTimeout = null;
  let peerConnection = null;
  let currentCall = null;
  let isMuted = false;
  let isCameraOff = false;
  let localStream = null;
  let currentFacingMode = 'user';
  let messageUnsubscribe = null;
  let ringtoneInterval = null;
  let ringtoneContext = null;
  let callStartTime = null;
  let debugLogs = [];

  // ─── E2EE State ───────────────────────────────────────
  let myPrivateKey = null;
  const sharedKeyCache = {};

  // ─── DOM Elements ─────────────────────────────────────

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const authScreen = $('#auth-screen');
  const chatScreen = $('#chat-screen');
  const authForm = $('#auth-form');
  const authError = $('#auth-error');
  const sidebar = $('#sidebar');
  const contactsList = $('#contacts-list');
  const chatEmpty = $('#chat-empty');
  const chatActive = $('#chat-active');
  const chatName = $('#chat-name');
  const chatStatus = $('#chat-status');
  const chatAvatar = $('#chat-avatar');
  const messagesList = $('#messages-list');
  const messagesContainer = $('#messages-container');
  const messageInput = $('#message-input');
  const sendBtn = $('#send-btn');
  const typingIndicator = $('#typing-indicator');
  const callOverlay = $('#call-overlay');
  const incomingCallModal = $('#incoming-call');
  const contactSearch = $('#contact-search');

  // ─── Avatar Colors & Helpers ──────────────────────────

  const avatarColors = [
    'linear-gradient(135deg, #6366f1, #8b5cf6)',
    'linear-gradient(135deg, #ec4899, #f43f5e)',
    'linear-gradient(135deg, #14b8a6, #06b6d4)',
    'linear-gradient(135deg, #f59e0b, #ef4444)',
    'linear-gradient(135deg, #10b981, #3b82f6)',
    'linear-gradient(135deg, #8b5cf6, #ec4899)',
    'linear-gradient(135deg, #06b6d4, #6366f1)',
    'linear-gradient(135deg, #f43f5e, #fbbf24)',
  ];

  function getAvatarColor(id) {
    const seed = String(id).split('').reduce((a, b) => a + b.charCodeAt(0), 0);
    return avatarColors[seed % avatarColors.length];
  }

  function getInitials(name) {
    if (!name) return '??';
    return name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
  }

  function setAvatarEl(el, user) {
    if (!user) return;
    el.textContent = getInitials(user.displayName);
    el.style.background = getAvatarColor(user.id);
  }

  function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function formatTime(timestamp) {
    const date = timestamp?.toDate ? timestamp.toDate() : new Date(timestamp);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  // ─── Auth ─────────────────────────────────────────────

  async function processAuth(displayName, inviteId = null) {
    const username = displayName.toLowerCase().replace(/\s+/g, '');
    const snapshot = await firestore.collection('users').where('username', '==', username).get();
      
    if (!snapshot.empty) {
      // Login
      const userData = snapshot.docs[0].data();
      currentUser = { id: snapshot.docs[0].id, username: userData.username, displayName: userData.displayName };
    } else {
      // Register
      const docRef = await firestore.collection('users').add({
        username, displayName,
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        online: true
      });
      currentUser = { id: docRef.id, username, displayName };
      
      const allUsers = await firestore.collection('users').get();
      allUsers.docs.forEach(d => {
        const u = d.data();
        if (d.id !== docRef.id && u.fcmToken) {
          fetch('/api/notify', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: u.fcmToken, title: "New Family Member 🎉", body: `${displayName} just joined FamilyLink!` })
          });
        }
      });
    }

    if (inviteId && currentUser.id !== inviteId) {
      await firestore.collection('users').doc(currentUser.id).update({
        friendIds: firebase.firestore.FieldValue.arrayUnion(inviteId)
      });
      await firestore.collection('users').doc(inviteId).update({
        friendIds: firebase.firestore.FieldValue.arrayUnion(currentUser.id)
      });
    }

    localStorage.setItem('familylink_user', JSON.stringify(currentUser));
    initChat();
  }

  // Handle Magic Invite Link
  const urlParams = new URLSearchParams(window.location.search);
  const inviteId = urlParams.get('i');
  const inviteName = urlParams.get('n');

  if (inviteId && inviteName) {
    processAuth(inviteName, inviteId)
      .then(() => { window.history.replaceState({}, document.title, window.location.pathname); })
      .catch(e => console.error("Invite login failed", e));
  } else {
    // Check saved session
    try {
      const saved = localStorage.getItem('familylink_user');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed && parsed.id) {
          currentUser = parsed;
          initChat();
        }
      }
    } catch (e) {}
  }

  // Manual Auth
  authForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    authError.classList.add('hidden');
    const displayName = $('#auth-name').value.trim();
    if (!displayName) return;

    try {
      await processAuth(displayName);
    } catch (err) {
      console.error(err);
      authError.textContent = 'Something went wrong. Please try again.';
      authError.classList.remove('hidden');
      authForm.classList.add('shake');
      setTimeout(() => authForm.classList.remove('shake'), 400);
    }
  });

  // Logout
  $('#logout-btn').addEventListener('click', async () => {
    if (currentUser) {
      await firestore.collection('users').doc(currentUser.id).update({ online: false });
    }
    localStorage.removeItem('familylink_user');
    currentUser = null;
    activeChat = null;
    location.reload();
  });

  // ─── Init & Messaging ─────────────────────────────────

  function initChat() {
    authScreen.classList.remove('active');
    authScreen.style.display = 'none';
    chatScreen.style.display = '';

    if ('Notification' in window && Notification.permission !== 'granted' && Notification.permission !== 'denied') {
      Notification.requestPermission();
    }
    chatScreen.classList.add('active');

    setAvatarEl($('#sidebar-avatar'), currentUser);
    $('#sidebar-username').textContent = currentUser.displayName;

    connectMessaging();
    registerPushNotifications();
    initEncryption();
  }

  // ─── E2EE Crypto ──────────────────────────────────────

  async function initEncryption() {
    try {
      const storedPriv = localStorage.getItem(`privKey_${currentUser.id}`);
      const storedPub  = localStorage.getItem(`pubKey_${currentUser.id}`);

      if (storedPriv && storedPub) {
        myPrivateKey = await crypto.subtle.importKey(
          'jwk', JSON.parse(storedPriv),
          { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveKey']
        );
        // Refresh public key in Firestore (in case it was cleared)
        await firestore.collection('users').doc(currentUser.id).update({ publicKeyJwk: JSON.parse(storedPub) });
      } else {
        const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey']);
        const privJwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
        const pubJwk  = await crypto.subtle.exportKey('jwk', kp.publicKey);
        localStorage.setItem(`privKey_${currentUser.id}`, JSON.stringify(privJwk));
        localStorage.setItem(`pubKey_${currentUser.id}`,  JSON.stringify(pubJwk));
        myPrivateKey = kp.privateKey;
        await firestore.collection('users').doc(currentUser.id).update({ publicKeyJwk: pubJwk });
      }
      console.log('E2EE ready 🔒');
    } catch (e) {
      console.error('E2EE init failed', e);
    }
  }

  async function getSharedKey(otherUserId) {
    if (sharedKeyCache[otherUserId]) return sharedKeyCache[otherUserId];
    if (!myPrivateKey) return null;
    try {
      const doc = await firestore.collection('users').doc(otherUserId).get();
      const pubJwk = doc.data()?.publicKeyJwk;
      if (!pubJwk) return null;
      const theirKey = await crypto.subtle.importKey(
        'jwk', pubJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, []
      );
      const shared = await crypto.subtle.deriveKey(
        { name: 'ECDH', public: theirKey },
        myPrivateKey,
        { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
      );
      sharedKeyCache[otherUserId] = shared;
      return shared;
    } catch (e) {
      console.error('getSharedKey failed', e);
      return null;
    }
  }

  async function encryptText(text, sharedKey) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const enc = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, sharedKey, new TextEncoder().encode(text));
    return {
      iv:   btoa(String.fromCharCode(...iv)),
      data: btoa(String.fromCharCode(...new Uint8Array(enc)))
    };
  }

  async function decryptText(obj, sharedKey) {
    try {
      const iv   = Uint8Array.from(atob(obj.iv),   c => c.charCodeAt(0));
      const data = Uint8Array.from(atob(obj.data), c => c.charCodeAt(0));
      const dec  = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, sharedKey, data);
      return new TextDecoder().decode(dec);
    } catch {
      return null; // Decryption failed (different device / missing key)
    }
  }

  async function registerPushNotifications() {
    try {
      const messaging = firebase.messaging();
      const token = await messaging.getToken({ vapidKey: 'BM5f-Qg5EvdAjaTSKv2POqEQsKqDrdk5F0J_5ttPCVMX2ABflim5KMmz2-hKopILH9fR52hlClPpeFRhE3qYPnc' });
      if (token && currentUser) {
        console.log('FCM Token obtained');
        await firestore.collection('users').doc(currentUser.id).update({ fcmToken: token });
      }
      messaging.onMessage((payload) => {
        console.log('Foreground push received:', payload);
        // Let the existing onSnapshot handlers handle the foreground UI updates
      });
    } catch (e) {
      console.error('Failed to configure Push Notifications', e);
    }
  }

  async function triggerPushNotification(targetUserId, title, body) {
    try {
      const userDoc = await firestore.collection('users').doc(targetUserId).get();
      if (!userDoc.exists) return;
      const targetToken = userDoc.data().fcmToken;
      if (!targetToken) return;

      await fetch('/api/notify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: targetToken, title, body })
      });
    } catch (e) {
      console.error('Failed to trigger push notification:', e);
    }
  }

  function connectMessaging() {
    const userRef = firestore.collection('users').doc(currentUser.id);
    userRef.update({ online: true, lastSeen: firebase.firestore.FieldValue.serverTimestamp() });

    window.addEventListener('beforeunload', () => userRef.update({ online: false }));

    // Listen for users
    firestore.collection('users').onSnapshot((snapshot) => {
      snapshot.docChanges().forEach(change => {
        if (change.type === 'added') {
          const u = change.doc.data();
          const created = u.createdAt?.toMillis ? u.createdAt.toMillis() : 0;
          if (created > Date.now() - 10000 && change.doc.id !== currentUser.id) {
            if ('Notification' in window && Notification.permission === 'granted') {
              new Notification('New Family Member 🎉', { body: `${u.displayName} just joined FamilyLink!` });
            }
          }
        }
      });

      const allUsers = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      const me = allUsers.find(u => u.id === currentUser.id);
      const friendIds = me?.friendIds || [];

      contacts = allUsers.filter(u => u.id !== currentUser.id && friendIds.includes(u.id));
      onlineUsers = new Set(contacts.filter(u => u.online).map(u => u.id));
      renderContacts();
      updateChatStatus();
    });

    // Listen for global notifications
    firestore.collection('messages')
      .where('toUserId', '==', currentUser.id)
      .where('read', '==', false)
      .onSnapshot((snapshot) => {
        snapshot.docChanges().forEach(change => {
          if (change.type === 'added') {
            const msg = change.doc.data();
            if (!activeChat || activeChat.id !== msg.fromUserId) {
              showNotification(msg);
            }
          }
        });
      });

    // Handle Signaling (Calls)
    firestore.collection('signaling')
      .where('toUserId', '==', currentUser.id)
      .onSnapshot((snapshot) => {
        snapshot.docChanges().forEach(change => {
          if (change.type === 'added') {
            const data = change.doc.data();
            const created = data.createdAt?.toMillis ? data.createdAt.toMillis() : 0;
            // Ignore signals older than current session
            if (created < callStartTime - 5000) return; 
            handleSignaling(data, change.doc);
          }
          if (change.type === 'removed' && currentCall) {
            logCall('Incoming signaling doc removed');
            endCall();
          }
        });
      });

    firestore.collection('signaling')
      .where('fromUserId', '==', currentUser.id)
      .onSnapshot((snapshot) => {
        snapshot.docChanges().forEach(change => {
          if (change.type === 'modified' || change.type === 'added') {
            const data = change.doc.data();
            const created = data.createdAt?.toMillis ? data.createdAt.toMillis() : 0;
            if (created < callStartTime - 5000) return;
            handleSignaling(data, change.doc);
          }
          if (change.type === 'removed' && currentCall) {
            logCall('Outgoing signaling doc removed');
            endCall();
          }
        });
      });
  }

  function renderContacts(filter = '') {
    const filtered = filter ? contacts.filter(c => c.displayName.toLowerCase().includes(filter.toLowerCase())) : contacts;
    contactsList.innerHTML = filtered.map(contact => {
      const isOnline = onlineUsers.has(contact.id);
      const isActive = activeChat && activeChat.id === contact.id;
      return `
        <div class="contact-item ${isActive ? 'active' : ''}" data-user-id="${contact.id}">
          <div class="avatar" style="background: ${getAvatarColor(contact.id)}">
            ${getInitials(contact.displayName)}
            ${isOnline ? '<span class="online-dot"></span>' : ''}
          </div>
          <div class="contact-info">
            <div class="contact-name">${escapeHtml(contact.displayName)}</div>
            <div class="contact-last-msg" id="last-msg-${contact.id}"></div>
          </div>
        </div>`;
    }).join('');

    $$('.contact-item').forEach(el => {
      el.addEventListener('click', () => {
        const contact = contacts.find(c => c.id === el.dataset.userId);
        if (contact) openChat(contact);
      });
    });
  }

  async function openChat(contact) {
    activeChat = contact;
    chatEmpty.classList.add('hidden');
    chatActive.classList.remove('hidden');
    chatName.textContent = contact.displayName;
    setAvatarEl(chatAvatar, contact);
    updateChatStatus();

    $$('.contact-item').forEach(el => el.classList.toggle('active', el.dataset.userId === contact.id));
    if (window.innerWidth <= 768) sidebar.classList.add('collapsed');

    loadMessages();
    messageInput.focus();
  }

  function loadMessages() {
    if (messageUnsubscribe) messageUnsubscribe();
    messagesList.innerHTML = '<div class="loading-spinner"></div>';
    
    const chatId = [currentUser.id, activeChat.id].sort().join('_');
    const q = firestore.collection('messages').where('chatId', '==', chatId);

    messageUnsubscribe = q.onSnapshot((snapshot) => {
      let messages = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      
      // Client-side sort to avoid composite index requirement
      messages.sort((a, b) => {
        const t1 = a.createdAt?.toMillis ? a.createdAt.toMillis() : (a.createdAt || 0);
        const t2 = b.createdAt?.toMillis ? b.createdAt.toMillis() : (b.createdAt || 0);
        return t1 - t2;
      });

      renderMessages(messages);
      scrollToBottom();
      
      snapshot.docs.forEach(doc => {
        if (doc.data().toUserId === currentUser.id && !doc.data().read) doc.ref.update({ read: true });
      });
    });
  }

  async function renderMessages(messages) {
    let html = '';
    let lastDate = '';
    for (const msg of messages) {
      const msgDate = msg.createdAt?.toDate ? msg.createdAt.toDate().toLocaleDateString() : 'Pending';
      if (msgDate !== lastDate) {
        lastDate = msgDate;
        html += `<div class="message-date-divider"><span>${msgDate}</span></div>`;
      }
      const isSent = msg.fromUserId === currentUser.id;
      const otherId = isSent ? msg.toUserId : msg.fromUserId;

      // Decrypt if encrypted
      let displayContent = msg.content;
      let displayAudio   = msg.audioData || msg.audioUrl;

      if (msg.encrypted) {
        const key = await getSharedKey(otherId);
        if (key) {
          if (msg.type === 'text' && typeof msg.content === 'object') {
            displayContent = await decryptText(msg.content, key) || '🔒 [Encrypted]';
          }
          if (msg.type === 'voice' && typeof msg.audioData === 'object') {
            displayAudio = await decryptText(msg.audioData, key) || null;
          }
        } else {
          displayContent = '🔒 [Encrypted — open on original device]';
        }
      }

      const contentHtml = msg.type === 'voice'
        ? (displayAudio ? `<div class="voice-message"><audio src="${displayAudio}" controls></audio></div>` : `<div class="message-content">🎤 Voice message</div>`)
        : `<div class="message-content">${escapeHtml(displayContent)}</div>`;

      html += `
        <div class="message ${isSent ? 'sent' : 'received'}">
          ${contentHtml}
          <div class="message-time">${formatTime(msg.createdAt)}${isSent ? (msg.read ? ' ✓✓' : ' ✓') : ''}</div>
        </div>`;
    }
    messagesList.innerHTML = html || '<div style="text-align:center;padding:40px;opacity:0.5">No messages yet</div>';
  }

  async function sendMessage() {
    const content = messageInput.value.trim();
    if (!content || !activeChat) return;

    const chatId = [currentUser.id, activeChat.id].sort().join('_');
    const sharedKey = await getSharedKey(activeChat.id);

    let payload;
    if (sharedKey) {
      payload = { chatId, fromUserId: currentUser.id, toUserId: activeChat.id,
        content: await encryptText(content, sharedKey), type: 'text', encrypted: true, read: false,
        createdAt: firebase.firestore.FieldValue.serverTimestamp() };
    } else {
      payload = { chatId, fromUserId: currentUser.id, toUserId: activeChat.id,
        content, type: 'text', read: false,
        createdAt: firebase.firestore.FieldValue.serverTimestamp() };
    }

    firestore.collection('messages').add(payload);
    triggerPushNotification(activeChat.id, `New message from ${currentUser.displayName}`, '💬 New message');

    messageInput.value = '';
    messageInput.style.height = '';
    sendBtn.disabled = true;
    scrollToBottom();
  }

  sendBtn.addEventListener('click', sendMessage);
  messageInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } });
  messageInput.addEventListener('input', () => { sendBtn.disabled = !messageInput.value.trim(); });

  // ─── Voice Recording ──────────────────────────────────
  let mediaRecorder;
  let audioChunks = [];
  let recTimerInterval;
  const micBtn = $('#mic-btn');

  micBtn.addEventListener('mousedown', startRecording);
  micBtn.addEventListener('touchstart', (e) => { e.preventDefault(); startRecording(); });
  window.addEventListener('mouseup', stopRecording);
  window.addEventListener('touchend', stopRecording);

  async function startRecording() {
    if (!activeChat) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaRecorder = new MediaRecorder(stream);
      audioChunks = [];
      mediaRecorder.ondataavailable = e => { if (e.data.size > 0) audioChunks.push(e.data); };
      mediaRecorder.start(100); // collect data every 100ms

      micBtn.classList.add('recording');

      // Show recording indicator with live timer
      const indicator = document.getElementById('recording-indicator');
      const timerEl = document.getElementById('rec-timer');
      indicator.style.display = 'flex';
      let secs = 0;
      recTimerInterval = setInterval(() => {
        secs++;
        timerEl.textContent = secs + 's';
      }, 1000);

    } catch (e) {
      console.error('Recording error', e);
      if (e.name === 'NotAllowedError') {
        alert('Microphone access was denied. Please allow microphone permissions in your browser settings.');
      } else {
        alert('Could not start recording: ' + e.message);
      }
    }
  }

  function stopRecording() {
    if (!mediaRecorder || mediaRecorder.state !== 'recording') return;

    // Hide indicator
    document.getElementById('recording-indicator').style.display = 'none';
    clearInterval(recTimerInterval);

    micBtn.classList.remove('recording');

    // Use a Promise to wait for onstop before uploading
    const stopped = new Promise(resolve => { mediaRecorder.onstop = resolve; });
    mediaRecorder.stop();
    mediaRecorder.stream.getTracks().forEach(t => t.stop());

    stopped.then(uploadRecording);
  }

  async function uploadRecording() {
    if (audioChunks.length === 0) return;
    const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
    if (audioBlob.size < 500) return; // Ignore accidental taps

    // Show uploading status
    const oldStatus = $('#chat-status').textContent;
    $('#chat-status').textContent = 'Sending voice message...';

    try {
      // Convert blob to base64 — no Storage plan needed
      const base64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result); // result is "data:audio/webm;base64,..."
        reader.onerror = reject;
        reader.readAsDataURL(audioBlob);
      });

      sendVoiceMessage(base64);
    } catch (e) {
      console.error('Voice message error', e);
      alert('Failed to send voice message: ' + e.message);
    } finally {
      $('#chat-status').textContent = oldStatus;
    }
  }

  async function sendVoiceMessage(audioData) {
    const chatId = [currentUser.id, activeChat.id].sort().join('_');
    const sharedKey = await getSharedKey(activeChat.id);

    let payload;
    if (sharedKey) {
      payload = { chatId, fromUserId: currentUser.id, toUserId: activeChat.id,
        content: 'Voice message', type: 'voice',
        audioData: await encryptText(audioData, sharedKey),
        encrypted: true, read: false,
        createdAt: firebase.firestore.FieldValue.serverTimestamp() };
    } else {
      payload = { chatId, fromUserId: currentUser.id, toUserId: activeChat.id,
        content: 'Voice message', type: 'voice', audioData, read: false,
        createdAt: firebase.firestore.FieldValue.serverTimestamp() };
    }

    firestore.collection('messages').add(payload);
    triggerPushNotification(activeChat.id, `New voice message from ${currentUser.displayName}`, '🎤 Voice message');
    scrollToBottom();
  }

  // ─── Add Contact Logic ────────────────────────────────

  const addContactModal  = document.getElementById('add-contact-modal');
  const addContactInput  = document.getElementById('add-contact-input');
  const addContactError  = document.getElementById('add-contact-error');
  const addContactSubmit = document.getElementById('add-contact-submit');
  const addContactCancel = document.getElementById('add-contact-cancel');

  document.getElementById('add-contact-btn').addEventListener('click', () => {
    addContactInput.value = '';
    addContactError.style.display = 'none';
    addContactModal.style.display = 'flex';
    addContactInput.focus();
  });

  addContactCancel.addEventListener('click', () => { addContactModal.style.display = 'none'; });
  addContactModal.addEventListener('click', (e) => { if (e.target === addContactModal) addContactModal.style.display = 'none'; });

  addContactSubmit.addEventListener('click', addContact);
  addContactInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') addContact(); });

  async function addContact() {
    const invitedName = addContactInput.value.trim();
    if (!invitedName) return;

    const inviteUrl = `${window.location.origin}${window.location.pathname}?i=${currentUser.id}&n=${encodeURIComponent(invitedName)}`;
    
    try {
      await navigator.clipboard.writeText(inviteUrl);
      addContactModal.style.display = 'none';
      alert(`Invite link for ${invitedName} copied to clipboard!\n\nSend this link to them. When they open it, they'll instantly be logged in and connected to you.`);
    } catch (e) {
      addContactError.textContent = 'Failed to copy link. Try again.';
      addContactError.style.display = 'block';
    }
  }

  function updateChatStatus() {
    if (!activeChat) return;
    const online = onlineUsers.has(activeChat.id);
    chatStatus.textContent = online ? 'Online' : 'Offline';
    chatStatus.className = 'status-text' + (online ? ' online' : '');
    
    // Ensure the viewport is at the top to prevent hidden headers on some mobile browsers
    if (window.innerWidth <= 768) window.scrollTo(0, 0);
  }

  // ─── Signaling & Calls ────────────────────────────────

  // ─── Signaling & Calls ────────────────────────────────

  function logCall(msg, data = {}) {
    const time = new Date().toLocaleTimeString();
    const logMsg = `[${time}] ${msg}`;
    console.log(`%c${logMsg}`, 'color: #8b5cf6; font-weight: bold;', data);
    
    // UI Logging
    debugLogs.push({ time, msg, data: JSON.stringify(data) });
    if (debugLogs.length > 50) debugLogs.shift();
    updateDebugUI();
  }

  function updateDebugUI() {
    const panel = $('#debug-panel');
    if (!panel) return;
    panel.innerHTML = debugLogs.map(l => 
      `<div class="debug-line"><strong>${l.time}</strong> ${l.msg} <small>${l.data}</small></div>`
    ).join('');
    panel.scrollTop = panel.scrollHeight;
  }

  // Create debug-panel if it doesn't exist
  if (!$('#debug-container')) {
    const container = document.createElement('div');
    container.id = 'debug-container';
    container.style = 'position:fixed; bottom:0; left:0; width:100%; height:150px; background:rgba(0,0,0,0.85); color:#0f0; font-family:monospace; font-size:10px; overflow-y:auto; z-index:10000; border-top:1px solid #444; display:none; padding:5px; pointer-events:none;';
    const panel = document.createElement('div');
    panel.id = 'debug-panel';
    container.appendChild(panel);
    document.body.appendChild(container);

    // Toggle with 5 taps on the header
    let taps = 0;
    const header = $('.side-header') || $('.sidebar-header');
    if (header) {
      header.addEventListener('click', () => {
        taps++;
        if (taps === 5) {
          container.style.display = container.style.display === 'none' ? 'block' : 'none';
          container.style.pointerEvents = container.style.display === 'none' ? 'none' : 'auto';
          taps = 0;
        }
        setTimeout(() => { taps = (taps > 0) ? taps - 1 : 0; }, 3000);
      });
    }
  }

  function startCall(type) {
    if (!activeChat) return;
    logCall('Starting call...', { type, toUser: activeChat.displayName });
    
    currentCall = { userId: activeChat.id, type };
    callStartTime = Date.now();
    
    // Show call overlay
    callOverlay.classList.remove('hidden');
    $('#call-name').textContent = activeChat.displayName;
    setAvatarEl($('#call-avatar'), activeChat);
    $('#call-status').textContent = 'Ringing...';
    $('#call-avatar-display').classList.remove('hidden');
    $('#remote-video').style.display = 'none';
    $('#local-video').style.display = 'none';

    // Start local media immediately so user sees themselves
    initLocalMedia(type);
    
    // Send call request
    firestore.collection('signaling').add({
      fromUserId: currentUser.id,
      toUserId: activeChat.id,
      type: 'call-request',
      callType: type,
      status: 'ringing',
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    }).then(doc => {
      currentCall.id = doc.id;
      triggerPushNotification(activeChat.id, `Incoming ${type} call`, `${currentUser.displayName} is calling you!`);
    }).catch(e => {
      logCall('Failed to start call', e);
    });
  }

  async function initLocalMedia(type) {
    try {
      const constraints = {
        audio: true,
        video: type === 'video' ? { facingMode: currentFacingMode } : false
      };
      logCall('Requesting local media', constraints);
      localStream = await navigator.mediaDevices.getUserMedia(constraints);
      
      if (type === 'video') {
        const localVideo = $('#local-video');
        localVideo.srcObject = localStream;
        localVideo.style.display = 'block';
        localVideo.muted = true;
        localVideo.play().catch(e => logCall('Local video play failed', e));
      }
      return localStream;
    } catch (err) {
      logCall('Media error', err);
      $('#call-status').textContent = 'Camera/Mic error';
    }
  }

  $('#video-call-btn').addEventListener('click', () => startCall('video'));
  $('#voice-call-btn').addEventListener('click', () => startCall('voice'));

  $('#flip-camera').addEventListener('click', async () => {
    if (!localStream || !currentCall || currentCall.type !== 'video') return;
    
    currentFacingMode = currentFacingMode === 'user' ? 'environment' : 'user';
    logCall('Flipping camera to', currentFacingMode);
    $('#flip-camera').style.transform = currentFacingMode === 'environment' ? 'rotate(180deg)' : 'rotate(0deg)';
    $('#flip-camera').style.transition = 'transform 0.3s ease';

    try {
      const newStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { exact: currentFacingMode } },
        audio: true
      }).catch(e => {
        // Fallback for devices that don't support "exact" constraint gracefully
        return navigator.mediaDevices.getUserMedia({
          video: { facingMode: currentFacingMode },
          audio: true
        });
      });

      const newVideoTrack = newStream.getVideoTracks()[0];
      const newAudioTrack = newStream.getAudioTracks()[0];

      if (peerConnection) {
        const senders = peerConnection.getSenders();
        const videoSender = senders.find(s => s.track && s.track.kind === 'video');
        if (videoSender) videoSender.replaceTrack(newVideoTrack);
        
        const audioSender = senders.find(s => s.track && s.track.kind === 'audio');
        if (audioSender) audioSender.replaceTrack(newAudioTrack);
      }

      // Stop old tracks to release camera hardware
      localStream.getTracks().forEach(t => t.stop());
      localStream = newStream;
      
      const localVideo = $('#local-video');
      localVideo.srcObject = localStream;
      localVideo.muted = true;
      localVideo.play().catch(e => logCall('Local video play failed on flip', e));

      // Restore mute/camera states
      if (isMuted) localStream.getAudioTracks().forEach(t => t.enabled = false);
      if (isCameraOff) localStream.getVideoTracks().forEach(t => t.enabled = false);
      
      logCall('Camera flip successful');
    } catch (err) {
      logCall('Failed to flip camera', err);
      // Revert state if failed
      currentFacingMode = currentFacingMode === 'user' ? 'environment' : 'user';
    }
  });

  async function handleSignaling(data, doc) {
    logCall('Signaling change detected', { type: data.type, status: data.status });

    // 1. Incoming Call Request
    if (data.type === 'call-request' && data.status === 'ringing') {
      if (currentCall) return; // Busy
      logCall('Incoming call request', data);
      callStartTime = data.createdAt?.toMillis ? data.createdAt.toMillis() : Date.now();
      currentCall = { id: doc.id, userId: data.fromUserId, type: data.callType };
      showIncomingCall(contacts.find(c => c.id === data.fromUserId), data.callType);
    } 
    // 2. Call Accepted by Callee (Caller receives this)
    else if (data.type === 'call-request' && data.status === 'accepted' && data.fromUserId === currentUser.id) {
      if (currentCall && !callTimerInterval) {
        logCall('Call accepted by other party', data);
        $('#call-status').textContent = 'Connecting...';
        createPeerConnection(true);
      }
    }
    // 3. WebRTC Negotiation
    else if (data.type === 'webrtc-offer' && data.toUserId === currentUser.id) {
      logCall('WebRTC Offer received');
      handleWebRTCOffer(data, doc);
    }
    else if (data.type === 'webrtc-answer' && data.toUserId === currentUser.id) {
      logCall('WebRTC Answer received');
      handleWebRTCAnswer(data);
    }
    else if (data.type === 'ice-candidate' && data.toUserId === currentUser.id) {
      logCall('ICE Candidate received');
      handleICECandidate(data);
    }
    // 4. Call Terminated
    else if (data.type === 'call-request' && data.status === 'rejected') {
      logCall('Call rejected');
      endCall();
    }
  }

  function showIncomingCall(caller, type) {
    if (!caller) return;
    logCall('Showing incoming call UI', { caller: caller.displayName });
    incomingCallModal.classList.remove('hidden');
    $('#incoming-name').textContent = caller.displayName;
    setAvatarEl($('#incoming-avatar'), caller);
    playRingtone();
    
    if ('Notification' in window && Notification.permission === 'granted') {
      new Notification(`Incoming ${type} call`, { body: `${caller.displayName} is calling you!` });
    }
  }

    $('#accept-call-btn').addEventListener('click', async () => {
      logCall('Accepting incoming call');
      incomingCallModal.classList.add('hidden');
      stopRingtone();
      
      callOverlay.classList.remove('hidden');
      const caller = contacts.find(c => c.id === currentCall.userId);
      if (caller) {
        $('#call-name').textContent = caller.displayName;
        setAvatarEl($('#call-avatar'), caller);
      }
      $('#call-status').textContent = 'Connecting...';
  
      // Get camera/mic BEFORE telling the caller we accepted, so the offer arrives after tracks are added
      await createPeerConnection(false);

      if (currentCall?.id) {
        firestore.collection('signaling').doc(currentCall.id).update({
          status: 'accepted'
        });
      }
    });

  $('#reject-call-btn').addEventListener('click', () => {
    logCall('Rejecting incoming call');
    incomingCallModal.classList.add('hidden');
    stopRingtone();
    if (currentCall?.id) {
      firestore.collection('signaling').doc(currentCall.id).update({ status: 'rejected' });
    }
    currentCall = null;
  });

  // ─── WebRTC Implementation ────────────────────────────
  
  const ICE_SERVERS = { 
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      {
        urls: [
          "turn:openrelay.metered.ca:80?transport=udp",
          "turn:openrelay.metered.ca:80?transport=tcp",
          "turns:openrelay.metered.ca:443?transport=tcp"
        ],
        username: "openrelayproject",
        credential: "openrelayproject"
      }
    ] 
  };


  async function createPeerConnection(isInitiator) {
    logCall('Creating PeerConnection', { isInitiator });
    peerConnection = new RTCPeerConnection(ICE_SERVERS);

    try {
      if (!localStream) {
        await initLocalMedia(currentCall.type);
      }
      
      if (!localStream) throw new Error('Failed to get local stream');

      localStream.getTracks().forEach(track => {
        logCall(`Adding ${track.kind} track to PC`);
        peerConnection.addTrack(track, localStream);
      });
    } catch (err) {
      logCall('Media error', err);
      $('#call-status').textContent = 'Camera/Mic error';
      return;
    }

    peerConnection.ontrack = (event) => {
      logCall('Remote track received', { kind: event.track.kind, streams: event.streams.length });
      const remoteVideo = $('#remote-video');
      remoteVideo.srcObject = event.streams[0];
      remoteVideo.style.display = 'block';
      
      // Ensure playback starts
      remoteVideo.play().then(() => {
        logCall('Remote video playing');
      }).catch(e => {
        logCall('Remote video play failed', e);
      });

      $('#call-avatar-display').classList.add('hidden');
      callOverlay.classList.add('connected');
      $('#call-status').textContent = 'Connected';
      startCallTimer();
    };

    peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        logCall('New ICE candidate');
        firestore.collection('signaling').add({
          fromUserId: currentUser.id,
          toUserId: currentCall.userId,
          type: 'ice-candidate',
          candidate: event.candidate.toJSON(),
          createdAt: firebase.firestore.FieldValue.serverTimestamp()
        });
      }
    };

    if (isInitiator) {
      logCall('Creating WebRTC Offer');
      const offer = await peerConnection.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: currentCall.type === 'video'
      });
      await peerConnection.setLocalDescription(offer);
      firestore.collection('signaling').add({
        fromUserId: currentUser.id,
        toUserId: currentCall.userId,
        type: 'webrtc-offer',
        sdp: offer.sdp,
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      });
    }
  }

  async function handleWebRTCOffer(data, doc) {
    if (!peerConnection) {
      logCall('PC not ready for offer, creating now');
      await createPeerConnection(false);
    }
    if (peerConnection.signalingState !== 'stable') {
      logCall('PC signaling state not stable:', { state: peerConnection.signalingState });
    }
    
    logCall('Setting Remote Description (Offer)');
    try {
      await peerConnection.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: data.sdp }));
      logCall('Creating WebRTC Answer');
      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);
      firestore.collection('signaling').add({
        fromUserId: currentUser.id,
        toUserId: currentCall.userId,
        type: 'webrtc-answer',
        sdp: answer.sdp,
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      });
    } catch (err) {
      logCall('Offer Handling Error', err);
    }
  }

  async function handleWebRTCAnswer(data) {
    if (!peerConnection) return;
    logCall('Handling WebRTC Answer');
    await peerConnection.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: data.sdp }));
  }

  async function handleICECandidate(data) {
    if (peerConnection) {
      logCall('Handling ICE Candidate');
      await peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate));
    }
  }

  $('#end-call-btn').addEventListener('click', () => {
    logCall('Ending call manually');
    if (currentCall?.id) firestore.collection('signaling').doc(currentCall.id).delete();
    endCall();
  });

  function endCall() {
    logCall('Terminating call session');
    if (callTimerInterval) { clearInterval(callTimerInterval); callTimerInterval = null; }
    if (peerConnection) { peerConnection.close(); peerConnection = null; }
    if (localStream) { 
      localStream.getTracks().forEach(t => t.stop()); 
      localStream = null; 
    }
    
    // Reset control states
    isMuted = false;
    isCameraOff = false;
    $('#toggle-mute').classList.remove('active');
    $('#toggle-camera').classList.remove('active');
    
    callOverlay.classList.remove('connected');
    callOverlay.classList.add('hidden');
    incomingCallModal.classList.add('hidden');
    currentCall = null;
    stopRingtone();
  }

  // ─── Call Controls ────────────────────────────────────

  $('#toggle-mute').addEventListener('click', () => {
    if (!localStream) return;
    isMuted = !isMuted;
    localStream.getAudioTracks().forEach(track => track.enabled = !isMuted);
    $('#toggle-mute').classList.toggle('active', isMuted);
    logCall(isMuted ? 'Muted' : 'Unmuted');
  });

  $('#toggle-camera').addEventListener('click', () => {
    if (!localStream || currentCall?.type !== 'video') return;
    isCameraOff = !isCameraOff;
    localStream.getVideoTracks().forEach(track => track.enabled = !isCameraOff);
    $('#toggle-camera').classList.toggle('active', isCameraOff);
    $('#local-video').style.opacity = isCameraOff ? '0' : '1';
    logCall(isCameraOff ? 'Camera Off' : 'Camera On');
  });

  function playRingtone() { 
    logCall('Playing ringtone');
    try {
      if (!ringtoneContext) ringtoneContext = new (window.AudioContext || window.webkitAudioContext)();
      if (ringtoneContext.state === 'suspended') ringtoneContext.resume();
      const beep = () => {
        const osc = ringtoneContext.createOscillator();
        const gain = ringtoneContext.createGain();
        osc.connect(gain); gain.connect(ringtoneContext.destination);
        osc.frequency.value = 440; gain.gain.value = 0.1;
        osc.start(); osc.stop(ringtoneContext.currentTime + 0.5);
      };
      beep(); ringtoneInterval = setInterval(beep, 1500);
    } catch(e) {}
  }

  function stopRingtone() {
    logCall('Stopping ringtone');
    if (ringtoneInterval) clearInterval(ringtoneInterval);
    if (ringtoneContext) ringtoneContext.close();
    ringtoneInterval = null; ringtoneContext = null;
  }

  let callTimerInterval = null;
  function startCallTimer() {
    logCall('Starting call timer');
    const start = Date.now();
    callTimerInterval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - start) / 1000);
      const m = Math.floor(elapsed / 60).toString().padStart(2, '0');
      const s = (elapsed % 60).toString().padStart(2, '0');
      $('#call-status').textContent = `${m}:${s}`;
    }, 1000);
  }

  function showNotification(msg) {
    const sender = contacts.find(c => c.id === msg.fromUserId);
    if (!sender) return;
    if (Notification.permission === 'granted') new Notification(sender.displayName, { body: msg.content.slice(0, 50) });
  }

  function scrollToBottom() { messagesContainer.scrollTo({ top: messagesContainer.scrollHeight, behavior: 'smooth' }); }

  $('#back-btn').addEventListener('click', () => { sidebar.classList.remove('collapsed'); activeChat = null; chatActive.classList.add('hidden'); chatEmpty.classList.remove('hidden'); });

})();
