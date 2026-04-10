/* ═══════════════════════════════════════════════════════
   FamilyLink — Client Application (Firestore Version)
   ═══════════════════════════════════════════════════════ */

(function() {
  'use strict';

  // ─── PWA Service Worker ──────────────────────────────
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/service-worker.js')
        .then(reg => console.log('ServiceWorker registered'))
        .catch(err => console.log('ServiceWorker failed', err));
    });
  }

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

  // ─── State ────────────────────────────────────────────

  let currentUser = null;
  let activeChat = null;
  let contacts = [];
  let onlineUsers = new Set();
  let typingTimeout = null;
  let peerConnection = null;
  let localStream = null;
  let currentCall = null;
  let isMuted = false;
  let isCameraOff = false;
  let messageUnsubscribe = null;
  let ringtoneInterval = null;
  let ringtoneContext = null;
  let callStartTime = null;

  // ─── DOM Elements ─────────────────────────────────────

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const authScreen = $('#auth-screen');
  const chatScreen = $('#chat-screen');
  const loginForm = $('#login-form');
  const registerForm = $('#register-form');
  const loginError = $('#login-error');
  const registerError = $('#register-error');
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

  // Toggle forms
  $('#show-register').addEventListener('click', (e) => {
    e.preventDefault();
    loginForm.classList.add('hidden');
    registerForm.classList.remove('hidden');
    loginError.classList.add('hidden');
  });

  $('#show-login').addEventListener('click', (e) => {
    e.preventDefault();
    registerForm.classList.add('hidden');
    loginForm.classList.remove('hidden');
    registerError.classList.add('hidden');
  });

  // Login
  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    loginError.classList.add('hidden');
    const username = $('#login-username').value.trim().toLowerCase();

    try {
      const snapshot = await firestore.collection('users')
        .where('username', '==', username)
        .get();

      if (snapshot.empty) throw new Error('User not found');

      const userData = snapshot.docs[0].data();
      const userId = snapshot.docs[0].id;

      currentUser = { id: userId, username: userData.username, displayName: userData.displayName };
      localStorage.setItem('familylink_user', JSON.stringify(currentUser));
      initChat();
    } catch (err) {
      loginError.textContent = err.message;
      loginError.classList.remove('hidden');
      loginForm.classList.add('shake');
      setTimeout(() => loginForm.classList.remove('shake'), 400);
    }
  });

  // Register
  registerForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    registerError.classList.add('hidden');
    const username = $('#reg-username').value.trim().toLowerCase();
    const displayName = $('#reg-displayname').value.trim();

    try {
      const existing = await firestore.collection('users').where('username', '==', username).get();
      if (!existing.empty) throw new Error('Username taken');

      const docRef = await firestore.collection('users').add({
        username, displayName,
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        online: true
      });
      
      currentUser = { id: docRef.id, username, displayName };
      localStorage.setItem('familylink_user', JSON.stringify(currentUser));
      initChat();
    } catch (err) {
      registerError.textContent = err.message;
      registerError.classList.remove('hidden');
      registerForm.classList.add('shake');
      setTimeout(() => registerForm.classList.remove('shake'), 400);
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
    chatScreen.classList.add('active');

    setAvatarEl($('#sidebar-avatar'), currentUser);
    $('#sidebar-username').textContent = currentUser.displayName;

    connectMessaging();
  }

  function connectMessaging() {
    const userRef = firestore.collection('users').doc(currentUser.id);
    userRef.update({ online: true, lastSeen: firebase.firestore.FieldValue.serverTimestamp() });

    window.addEventListener('beforeunload', () => userRef.update({ online: false }));

    // Listen for users
    firestore.collection('users').onSnapshot((snapshot) => {
      contacts = snapshot.docs
        .map(doc => ({ id: doc.id, ...doc.data() }))
        .filter(u => u.id !== currentUser.id);
      
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

  function renderMessages(messages) {
    let html = '';
    let lastDate = '';
    messages.forEach(msg => {
      const msgDate = msg.createdAt?.toDate ? msg.createdAt.toDate().toLocaleDateString() : 'Pending';
      if (msgDate !== lastDate) {
        lastDate = msgDate;
        html += `<div class="message-date-divider"><span>${msgDate}</span></div>`;
      }
      const isSent = msg.fromUserId === currentUser.id;
      html += `
        <div class="message ${isSent ? 'sent' : 'received'}">
          <div class="message-content">${escapeHtml(msg.content)}</div>
          <div class="message-time">${formatTime(msg.createdAt)}${isSent ? (msg.read ? ' ✓✓' : ' ✓') : ''}</div>
        </div>`;
    });
    messagesList.innerHTML = html || '<div style="text-align:center;padding:40px;opacity:0.5">No messages yet</div>';
  }

  function sendMessage() {
    const content = messageInput.value.trim();
    if (!content || !activeChat) return;

    const chatId = [currentUser.id, activeChat.id].sort().join('_');
    firestore.collection('messages').add({
      chatId, fromUserId: currentUser.id, toUserId: activeChat.id,
      content, type: 'text', read: false,
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });

    messageInput.value = '';
    messageInput.style.height = '';
    sendBtn.disabled = true;
    scrollToBottom();
  }

  sendBtn.addEventListener('click', sendMessage);
  messageInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } });
  messageInput.addEventListener('input', () => { sendBtn.disabled = !messageInput.value.trim(); });

  function updateChatStatus() {
    if (!activeChat) return;
    const online = onlineUsers.has(activeChat.id);
    chatStatus.textContent = online ? 'online' : 'offline';
    chatStatus.className = 'status-text' + (online ? ' online' : '');
  }

  // ─── Signaling & Calls ────────────────────────────────

  // ─── Signaling & Calls ────────────────────────────────

  function logCall(msg, data = {}) {
    const time = new Date().toLocaleTimeString();
    console.log(`%c[Call ${time}] ${msg}`, 'color: #8b5cf6; font-weight: bold;', data);
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
      logCall('Signaling doc created', { id: doc.id });
    });
  }

  $('#video-call-btn').addEventListener('click', () => startCall('video'));
  $('#voice-call-btn').addEventListener('click', () => startCall('voice'));

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
  }

  $('#accept-call-btn').addEventListener('click', () => {
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

    firestore.collection('signaling').doc(currentCall.id).update({
      status: 'accepted'
    });

    createPeerConnection(false);
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
  
  const ICE_SERVERS = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

  async function createPeerConnection(isInitiator) {
    logCall('Creating PeerConnection', { isInitiator });
    peerConnection = new RTCPeerConnection(ICE_SERVERS);

    try {
      const constraints = {
        audio: true,
        video: currentCall.type === 'video'
      };
      logCall('Requesting media devices', constraints);
      localStream = await navigator.mediaDevices.getUserMedia(constraints);
      
      if (currentCall.type === 'video') {
        $('#local-video').srcObject = localStream;
        $('#local-video').style.display = 'block';
      }

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
      logCall('Remote track received');
      $('#remote-video').srcObject = event.streams[0];
      $('#remote-video').style.display = 'block';
      $('#call-avatar-display').classList.add('hidden');
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
      const offer = await peerConnection.createOffer();
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
    if (peerConnection.signalingState !== 'stable') return;
    logCall('Handling WebRTC Offer');
    await peerConnection.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: data.sdp }));
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    firestore.collection('signaling').add({
      fromUserId: currentUser.id,
      toUserId: currentCall.userId,
      type: 'webrtc-answer',
      sdp: answer.sdp,
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });
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
    if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
    callOverlay.classList.add('hidden');
    incomingCallModal.classList.add('hidden');
    currentCall = null;
    stopRingtone();
  }

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
