importScripts('https://www.gstatic.com/firebasejs/10.8.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.8.0/firebase-messaging-compat.js');

const firebaseConfig = {
  apiKey: "AIzaSyCcnpQDPsQptHdZKHupXOZNqNbO1JOD1Ss",
  authDomain: "general-4686c.firebaseapp.com",
  projectId: "general-4686c",
  storageBucket: "general-4686c.firebasestorage.app",
  messagingSenderId: "810223700186",
  appId: "1:810223700186:web:7eeeac4b4e0f921cd7fde3"
};

firebase.initializeApp(firebaseConfig);
const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
  console.log('[firebase-messaging-sw.js] Received background message ', payload);
  const notificationTitle = payload.notification.title || 'Incoming Call';
  const notificationOptions = {
    body: payload.notification.body || 'Open the app to answer.',
    icon: '/logo.jpg',
    requireInteraction: true // Keeps the notification alive
  };

  self.registration.showNotification(notificationTitle, notificationOptions);
});
