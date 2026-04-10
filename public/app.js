/* ═══════════════════════════════════════════════════════
   FamilyLink — Client Application
   ═══════════════════════════════════════════════════════ */

(function() {
  'use strict';

  // ─── State ────────────────────────────────────────────

  let currentUser = null;
  let activeChat = null; // { id, username, displayName }
  let contacts = [];
  let onlineUsers = new Set();
  let socket = null;
  let typingTimeout = null;
  let peerConnection = null;
  let localStream = null;
  let currentCall = null; // { userId, type }
  let isMuted = false;
  let isCameraOff = false;

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

  // ─── Avatar Colors ────────────────────────────────────

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
    return avatarColors[id % avatarColors.length];
  }

  function getInitials(name) {
    return name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
  }

  function setAvatarEl(el, user) {
    el.textContent = getInitials(user.displayName);
    el.style.background = getAvatarColor(user.id);
  }

  // ─── Auth ─────────────────────────────────────────────

  // Ensure correct initial screen state
  chatScreen.style.display = 'none';
  chatScreen.classList.remove('active');
  authScreen.classList.add('active');

  // Check saved session
  try {
    const saved = localStorage.getItem('familylink_user');
    if (saved) {
      const parsed = JSON.parse(saved);
      if (parsed && parsed.id && parsed.username && parsed.displayName) {
        currentUser = parsed;
        initChat();
      } else {
        localStorage.removeItem('familylink_user');
      }
    }
  } catch (e) {
    localStorage.removeItem('familylink_user');
  }

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
    const username = $('#login-username').value.trim();
    const pin = $('#login-pin').value;

    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, pin })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      
      currentUser = data.user;
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
    const username = $('#reg-username').value.trim();
    const displayName = $('#reg-displayname').value.trim();
    const pin = $('#reg-pin').value;

    try {
      const res = await fetch('/api/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, displayName, pin })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      
      currentUser = data.user;
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
  $('#logout-btn').addEventListener('click', () => {
    localStorage.removeItem('familylink_user');
    currentUser = null;
    activeChat = null;
    if (socket) socket.disconnect();
    // Properly toggle screens
    chatScreen.classList.remove('active');
    chatScreen.style.display = 'none';
    authScreen.style.display = '';
    authScreen.classList.add('active');
    loginForm.reset();
    registerForm.reset();
  });

  // ─── Init Chat ────────────────────────────────────────

  function initChat() {
    // Explicitly hide auth, show chat
    authScreen.classList.remove('active');
    authScreen.style.display = 'none';
    chatScreen.style.display = '';  // Clear inline override
    chatScreen.classList.add('active');

    // Set sidebar user info
    setAvatarEl($('#sidebar-avatar'), currentUser);
    $('#sidebar-username').textContent = currentUser.displayName;

    // Connect socket
    connectSocket();

    // Load contacts
    loadContacts();
  }

  // ─── Socket.IO ────────────────────────────────────────

  function connectSocket() {
    socket = io({ transports: ['websocket', 'polling'] });

    socket.on('connect', () => {
      socket.emit('user:online', currentUser.id);
    });

    // Online users list
    socket.on('users:online', (users) => {
      onlineUsers = new Set(users);
      renderContacts();
      updateChatStatus();
    });

    // User status change
    socket.on('user:status', ({ userId, online }) => {
      if (online) onlineUsers.add(userId);
      else onlineUsers.delete(userId);
      renderContacts();
      updateChatStatus();
    });

    // Receive message
    socket.on('message:receive', (msg) => {
      if (activeChat && msg.fromUserId === activeChat.id) {
        appendMessage(msg);
        scrollToBottom();
        // Mark as read
        socket.emit('message:read', {
          messageId: msg.id,
          readByUserId: currentUser.id,
          fromUserId: msg.fromUserId
        });
      } else {
        // Show notification
        showNotification(msg);
      }
      // Update contact list with last message
      updateContactLastMessage(msg.fromUserId, msg.content);
    });

    // Sent confirmation
    socket.on('message:sent', (msg) => {
      // Update contact list
      if (activeChat) {
        updateContactLastMessage(activeChat.id, msg.content);
      }
    });

    // Read receipt
    socket.on('message:read', ({ messageId }) => {
      const msgEl = document.querySelector(`[data-msg-id="${messageId}"]`);
      if (msgEl) {
        const timeEl = msgEl.querySelector('.message-time');
        if (timeEl && !timeEl.textContent.includes('✓✓')) {
          timeEl.textContent = timeEl.textContent.replace('✓', '✓✓');
        }
      }
    });

    // Typing indicator
    socket.on('typing:indicator', ({ userId, typing }) => {
      if (activeChat && userId === activeChat.id) {
        typingIndicator.classList.toggle('hidden', !typing);
        if (typing) scrollToBottom();
      }
    });

    // ─── Call Signaling ─────────────────────────────────

    socket.on('call:incoming', ({ fromUserId, callType }) => {
      console.log('[Call] Incoming call from user', fromUserId, 'type:', callType);
      // Use loose comparison (==) to handle number/string mismatch
      let caller = contacts.find(c => c.id == fromUserId);
      if (!caller) {
        // Refresh contacts and try again, or use a fallback
        console.log('[Call] Caller not in contacts list, refreshing...');
        caller = { id: fromUserId, displayName: 'Family Member', username: 'unknown' };
        // Also refresh contacts in background
        loadContacts();
      }
      
      currentCall = { userId: Number(fromUserId), type: callType };
      showIncomingCall(caller, callType);
    });

    socket.on('call:accepted', async ({ fromUserId }) => {
      console.log('[Call] Call accepted by user', fromUserId);
      // Other party accepted, create and send offer
      try {
        await createPeerConnection(true);
      } catch (e) {
        console.error('[Call] Failed to create peer connection:', e);
      }
    });

    socket.on('call:rejected', () => {
      endCall();
      $('#call-status').textContent = 'Call rejected';
      setTimeout(() => callOverlay.classList.add('hidden'), 2000);
    });

    socket.on('call:unavailable', () => {
      endCall();
      $('#call-status').textContent = 'User is offline';
      setTimeout(() => callOverlay.classList.add('hidden'), 2000);
    });

    socket.on('call:ended', () => {
      endCall();
    });

    socket.on('webrtc:offer', async ({ fromUserId, offer }) => {
      console.log('[WebRTC] Received offer from user', fromUserId);
      try {
        await createPeerConnection(false);
        if (!peerConnection) {
          console.error('[WebRTC] PeerConnection not created');
          return;
        }
        await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);
        console.log('[WebRTC] Sending answer to user', fromUserId);
        socket.emit('webrtc:answer', { toUserId: fromUserId, answer });
      } catch (e) {
        console.error('[WebRTC] Error handling offer:', e);
      }
    });

    socket.on('webrtc:answer', async ({ answer }) => {
      if (peerConnection) {
        await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
      }
    });

    socket.on('webrtc:ice-candidate', async ({ candidate }) => {
      if (peerConnection && candidate) {
        try {
          await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (e) {
          console.error('Error adding ICE candidate:', e);
        }
      }
    });
  }

  // ─── Contacts ─────────────────────────────────────────

  async function loadContacts() {
    try {
      const res = await fetch('/api/users');
      contacts = (await res.json()).filter(u => u.id !== currentUser.id);
      renderContacts();
    } catch (err) {
      console.error('Failed to load contacts:', err);
    }
  }

  function renderContacts(filter = '') {
    const filtered = filter
      ? contacts.filter(c => c.displayName.toLowerCase().includes(filter.toLowerCase()))
      : contacts;

    contactsList.innerHTML = filtered.map(contact => {
      const isOnline = onlineUsers.has(contact.id);
      const isActive = activeChat && activeChat.id === contact.id;
      const initials = getInitials(contact.displayName);
      const color = getAvatarColor(contact.id);

      return `
        <div class="contact-item ${isActive ? 'active' : ''}" data-user-id="${contact.id}">
          <div class="avatar" style="background: ${color}">
            ${initials}
            ${isOnline ? '<span class="online-dot"></span>' : ''}
          </div>
          <div class="contact-info">
            <div class="contact-name">${escapeHtml(contact.displayName)}</div>
            <div class="contact-last-msg" id="last-msg-${contact.id}"></div>
          </div>
          <div class="contact-meta">
            <span class="contact-time" id="last-time-${contact.id}"></span>
          </div>
        </div>
      `;
    }).join('');

    // Attach click handlers
    $$('.contact-item').forEach(el => {
      el.addEventListener('click', () => {
        const userId = parseInt(el.dataset.userId);
        const contact = contacts.find(c => c.id === userId);
        if (contact) openChat(contact);
      });
    });
  }

  function updateContactLastMessage(userId, content) {
    const el = $(`#last-msg-${userId}`);
    const timeEl = $(`#last-time-${userId}`);
    if (el) {
      el.textContent = content.length > 30 ? content.slice(0, 30) + '...' : content;
    }
    if (timeEl) {
      timeEl.textContent = formatTime(new Date().toISOString());
    }
  }

  // Search contacts
  contactSearch.addEventListener('input', (e) => {
    renderContacts(e.target.value);
  });

  // ─── Chat ─────────────────────────────────────────────

  async function openChat(contact) {
    activeChat = contact;
    
    // Update UI
    chatEmpty.classList.add('hidden');
    chatActive.classList.remove('hidden');
    chatName.textContent = contact.displayName;
    setAvatarEl(chatAvatar, contact);
    updateChatStatus();

    // Mark in contacts
    $$('.contact-item').forEach(el => {
      el.classList.toggle('active', parseInt(el.dataset.userId) === contact.id);
    });

    // Mobile: hide sidebar
    if (window.innerWidth <= 768) {
      sidebar.classList.add('collapsed');
    }

    // Load messages
    await loadMessages();
    
    // Focus input
    messageInput.focus();
  }

  async function loadMessages() {
    if (!activeChat) return;
    
    messagesList.innerHTML = '<div class="loading-spinner"></div>';
    
    try {
      const res = await fetch(`/api/messages/${currentUser.id}/${activeChat.id}`);
      const messages = await res.json();
      renderMessages(messages);
      scrollToBottom(false);
    } catch (err) {
      console.error('Failed to load messages:', err);
      messagesList.innerHTML = '<p style="text-align:center;color:var(--text-muted);padding:20px">Failed to load messages</p>';
    }
  }

  function renderMessages(messages) {
    let html = '';
    let lastDate = '';

    messages.forEach(msg => {
      const msgDate = new Date(msg.createdAt).toLocaleDateString();
      if (msgDate !== lastDate) {
        lastDate = msgDate;
        const dateLabel = isToday(msg.createdAt) ? 'Today' 
                       : isYesterday(msg.createdAt) ? 'Yesterday' 
                       : msgDate;
        html += `<div class="message-date-divider"><span>${dateLabel}</span></div>`;
      }

      const isSent = msg.fromUserId === currentUser.id;
      html += `
        <div class="message ${isSent ? 'sent' : 'received'}" data-msg-id="${msg.id}">
          <div class="message-content">${escapeHtml(msg.content)}</div>
          <div class="message-time">${formatTime(msg.createdAt)}${isSent ? (msg.read ? ' ✓✓' : ' ✓') : ''}</div>
        </div>
      `;
    });

    messagesList.innerHTML = html || `
      <div style="text-align:center;padding:40px;color:var(--text-muted)">
        <p>No messages yet</p>
        <p style="font-size:13px;margin-top:4px">Say hello! 👋</p>
      </div>
    `;
  }

  function appendMessage(msg) {
    // Remove empty state
    const emptyState = messagesList.querySelector('div[style*="text-align:center"]');
    if (emptyState && !emptyState.classList.contains('message-date-divider')) {
      emptyState.remove();
    }

    const isSent = msg.fromUserId === currentUser.id;
    const div = document.createElement('div');
    div.className = `message ${isSent ? 'sent' : 'received'}`;
    div.dataset.msgId = msg.id;
    div.innerHTML = `
      <div class="message-content">${escapeHtml(msg.content)}</div>
      <div class="message-time">${formatTime(msg.createdAt)}${isSent ? ' ✓' : ''}</div>
    `;
    messagesList.appendChild(div);
  }

  function updateChatStatus() {
    if (!activeChat) return;
    const online = onlineUsers.has(activeChat.id);
    chatStatus.textContent = online ? 'online' : 'offline';
    chatStatus.className = 'status-text' + (online ? ' online' : '');
  }

  // ─── Send Message ─────────────────────────────────────

  function sendMessage() {
    const content = messageInput.value.trim();
    if (!content || !activeChat) return;

    socket.emit('message:send', {
      fromUserId: currentUser.id,
      toUserId: activeChat.id,
      content,
      type: 'text'
    });

    // Optimistically render
    appendMessage({
      id: Date.now(),
      fromUserId: currentUser.id,
      toUserId: activeChat.id,
      content,
      type: 'text',
      read: 0,
      createdAt: new Date().toISOString()
    });

    messageInput.value = '';
    messageInput.style.height = '';
    sendBtn.disabled = true;
    scrollToBottom();

    // Stop typing
    socket.emit('typing:stop', {
      fromUserId: currentUser.id,
      toUserId: activeChat.id
    });
  }

  sendBtn.addEventListener('click', sendMessage);

  messageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  // Auto-resize textarea
  messageInput.addEventListener('input', () => {
    sendBtn.disabled = !messageInput.value.trim();
    messageInput.style.height = '';
    messageInput.style.height = Math.min(messageInput.scrollHeight, 120) + 'px';

    // Typing indicator
    if (activeChat) {
      socket.emit('typing:start', {
        fromUserId: currentUser.id,
        toUserId: activeChat.id
      });
      clearTimeout(typingTimeout);
      typingTimeout = setTimeout(() => {
        socket.emit('typing:stop', {
          fromUserId: currentUser.id,
          toUserId: activeChat.id
        });
      }, 2000);
    }
  });

  // Back button (mobile)
  $('#back-btn').addEventListener('click', () => {
    sidebar.classList.remove('collapsed');
    activeChat = null;
    chatActive.classList.add('hidden');
    chatEmpty.classList.remove('hidden');
  });

  // ─── Video / Voice Call ───────────────────────────────

  const ICE_SERVERS = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' },
    ]
  };

  $('#video-call-btn').addEventListener('click', () => initiateCall('video'));
  $('#voice-call-btn').addEventListener('click', () => initiateCall('audio'));

  function initiateCall(type) {
    if (!activeChat) return;
    console.log('[Call] Initiating', type, 'call to user', activeChat.id, activeChat.displayName);
    
    currentCall = { userId: Number(activeChat.id), type };
    
    // Show call UI
    callOverlay.classList.remove('hidden');
    $('#call-status').textContent = 'Calling...';
    $('#call-name').textContent = activeChat.displayName;
    setAvatarEl($('#call-avatar'), activeChat);
    $('#call-avatar-display').classList.remove('hidden');
    
    // Hide videos initially
    $('#remote-video').style.display = 'none';
    $('#local-video').style.display = 'none';

    // Signal the call
    socket.emit('call:initiate', {
      fromUserId: currentUser.id,
      toUserId: activeChat.id,
      callType: type
    });
  }

  function showIncomingCall(caller, callType) {
    incomingCallModal.classList.remove('hidden');
    $('#incoming-name').textContent = caller.displayName;
    $('#incoming-type').textContent = `Incoming ${callType} call...`;
    setAvatarEl($('#incoming-avatar'), caller);

    // Play notification sound (simple beep)
    playRingtone();
  }

  $('#accept-call-btn').addEventListener('click', async () => {
    incomingCallModal.classList.add('hidden');
    stopRingtone();
    
    // Show call overlay
    callOverlay.classList.remove('hidden');
    const caller = contacts.find(c => c.id === currentCall.userId);
    if (caller) {
      $('#call-name').textContent = caller.displayName;
      setAvatarEl($('#call-avatar'), caller);
    }
    $('#call-status').textContent = 'Connecting...';
    $('#call-avatar-display').classList.remove('hidden');
    $('#remote-video').style.display = 'none';
    $('#local-video').style.display = 'none';

    // Tell caller we accepted
    socket.emit('call:accept', {
      fromUserId: currentUser.id,
      toUserId: currentCall.userId
    });
  });

  $('#reject-call-btn').addEventListener('click', () => {
    incomingCallModal.classList.add('hidden');
    stopRingtone();
    socket.emit('call:reject', {
      fromUserId: currentUser.id,
      toUserId: currentCall.userId
    });
    currentCall = null;
  });

  async function createPeerConnection(isInitiator) {
    peerConnection = new RTCPeerConnection(ICE_SERVERS);

    // Get media
    const constraints = {
      audio: true,
      video: currentCall.type === 'video' ? { width: 640, height: 480 } : false
    };

    try {
      localStream = await navigator.mediaDevices.getUserMedia(constraints);
      
      // Show local video
      if (currentCall.type === 'video') {
        const localVideo = $('#local-video');
        localVideo.srcObject = localStream;
        localVideo.style.display = 'block';
      }

      // Add tracks
      localStream.getTracks().forEach(track => {
        peerConnection.addTrack(track, localStream);
      });
    } catch (err) {
      console.error('Failed to get media:', err);
      $('#call-status').textContent = 'Camera/microphone access denied';
      return;
    }

    // Remote stream
    peerConnection.ontrack = (event) => {
      const remoteVideo = $('#remote-video');
      remoteVideo.srcObject = event.streams[0];
      remoteVideo.style.display = 'block';
      $('#call-avatar-display').classList.add('hidden');
      $('#call-status').textContent = 'Connected';
      
      // Start call timer
      startCallTimer();
    };

    // ICE candidates
    peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        socket.emit('webrtc:ice-candidate', {
          toUserId: currentCall.userId,
          candidate: event.candidate
        });
      }
    };

    peerConnection.oniceconnectionstatechange = () => {
      if (peerConnection.iceConnectionState === 'disconnected' || 
          peerConnection.iceConnectionState === 'failed') {
        endCall();
      }
    };

    // Create offer if initiator
    if (isInitiator) {
      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);
      socket.emit('webrtc:offer', {
        toUserId: currentCall.userId,
        offer
      });
    }
  }

  // Call timer
  let callTimerInterval = null;
  let callStartTime = null;

  function startCallTimer() {
    callStartTime = Date.now();
    callTimerInterval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - callStartTime) / 1000);
      const mins = Math.floor(elapsed / 60).toString().padStart(2, '0');
      const secs = (elapsed % 60).toString().padStart(2, '0');
      $('#call-status').textContent = `${mins}:${secs}`;
    }, 1000);
  }

  // Toggle mute
  $('#toggle-mute').addEventListener('click', () => {
    if (!localStream) return;
    isMuted = !isMuted;
    localStream.getAudioTracks().forEach(t => t.enabled = !isMuted);
    $('#toggle-mute').classList.toggle('active', isMuted);
  });

  // Toggle camera
  $('#toggle-camera').addEventListener('click', () => {
    if (!localStream) return;
    isCameraOff = !isCameraOff;
    localStream.getVideoTracks().forEach(t => t.enabled = !isCameraOff);
    $('#toggle-camera').classList.toggle('active', isCameraOff);
  });

  // End call
  $('#end-call-btn').addEventListener('click', () => {
    if (currentCall) {
      socket.emit('call:end', { toUserId: currentCall.userId });
    }
    endCall();
  });

  function endCall() {
    if (peerConnection) {
      peerConnection.close();
      peerConnection = null;
    }
    if (localStream) {
      localStream.getTracks().forEach(t => t.stop());
      localStream = null;
    }
    if (callTimerInterval) {
      clearInterval(callTimerInterval);
      callTimerInterval = null;
    }
    callOverlay.classList.add('hidden');
    incomingCallModal.classList.add('hidden');
    currentCall = null;
    isMuted = false;
    isCameraOff = false;
    $('#toggle-mute').classList.remove('active');
    $('#toggle-camera').classList.remove('active');
    stopRingtone();
  }

  // ─── Ringtone ─────────────────────────────────────────

  let ringtoneContext = null;
  let ringtoneInterval = null;

  function playRingtone() {
    try {
      ringtoneContext = new (window.AudioContext || window.webkitAudioContext)();
      
      function beep() {
        const osc = ringtoneContext.createOscillator();
        const gain = ringtoneContext.createGain();
        osc.connect(gain);
        gain.connect(ringtoneContext.destination);
        osc.frequency.value = 440;
        gain.gain.value = 0.3;
        osc.start();
        gain.gain.exponentialRampToValueAtTime(0.001, ringtoneContext.currentTime + 0.5);
        osc.stop(ringtoneContext.currentTime + 0.5);
      }
      
      beep();
      ringtoneInterval = setInterval(beep, 1500);
    } catch (e) {
      console.log('No audio support');
    }
  }

  function stopRingtone() {
    if (ringtoneInterval) {
      clearInterval(ringtoneInterval);
      ringtoneInterval = null;
    }
    if (ringtoneContext) {
      ringtoneContext.close();
      ringtoneContext = null;
    }
  }

  // ─── Notifications ────────────────────────────────────

  function showNotification(msg) {
    const sender = contacts.find(c => c.id === msg.fromUserId);
    if (!sender) return;

    // Browser notification
    if (Notification.permission === 'granted') {
      new Notification(`${sender.displayName}`, {
        body: msg.content.slice(0, 100),
        icon: '/favicon.ico'
      });
    } else if (Notification.permission !== 'denied') {
      Notification.requestPermission();
    }

    // In-app notification
    const notif = document.createElement('div');
    notif.className = 'notification-badge';
    notif.innerHTML = `
      <div class="avatar avatar-sm" style="background:${getAvatarColor(sender.id)}">${getInitials(sender.displayName)}</div>
      <div>
        <strong>${escapeHtml(sender.displayName)}</strong>
        <div style="font-size:13px;color:var(--text-secondary)">${escapeHtml(msg.content.slice(0, 50))}</div>
      </div>
    `;
    notif.addEventListener('click', () => {
      openChat(sender);
      notif.remove();
    });
    document.body.appendChild(notif);
    setTimeout(() => notif.remove(), 4000);
  }

  // Request notification permission
  if ('Notification' in window && Notification.permission === 'default') {
    setTimeout(() => Notification.requestPermission(), 3000);
  }

  // ─── Helpers ──────────────────────────────────────────

  function scrollToBottom(smooth = true) {
    requestAnimationFrame(() => {
      messagesContainer.scrollTo({
        top: messagesContainer.scrollHeight,
        behavior: smooth ? 'smooth' : 'auto'
      });
    });
  }

  function formatTime(isoStr) {
    const date = new Date(isoStr);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function isToday(isoStr) {
    const d = new Date(isoStr);
    const today = new Date();
    return d.toDateString() === today.toDateString();
  }

  function isYesterday(isoStr) {
    const d = new Date(isoStr);
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    return d.toDateString() === yesterday.toDateString();
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ─── Window Events ────────────────────────────────────

  // Reconnect on visibility change
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && currentUser && socket && !socket.connected) {
      socket.connect();
    }
  });

  // Handle window resize for mobile
  window.addEventListener('resize', () => {
    if (window.innerWidth > 768) {
      sidebar.classList.remove('collapsed');
    }
  });

})();
