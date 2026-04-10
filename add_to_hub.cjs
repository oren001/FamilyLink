const { initializeApp } = require('firebase/app');
const { getFirestore, collection, addDoc, serverTimestamp } = require('firebase/firestore');

const firebaseConfig = {
  apiKey: "AIzaSyCcnpQDPsQptHdZKHupXOZNqNbO1JOD1Ss",
  authDomain: "general-4686c.firebaseapp.com",
  projectId: "general-4686c",
  storageBucket: "general-4686c.firebasestorage.app",
  messagingSenderId: "810223700186",
  appId: "1:810223700186:web:7eeeac4b4e0f921cd7fde3"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

async function addFamilyLink() {
  try {
    const docRef = await addDoc(collection(db, 'apps'), {
      title: "FamilyLink",
      name: "FamilyLink",
      description: "Private family messenger with real-time text and video calling.",
      url: "https://family-link-46l.pages.dev",
      category: "Interactive",
      iconUrl: "https://img.icons8.com/neon/96/family-message.png",
      status: "live",
      updatedAt: serverTimestamp()
    });
    console.log("Document written with ID: ", docRef.id);
    process.exit(0);
  } catch (e) {
    console.error("Error adding document: ", e);
    process.exit(1);
  }
}

addFamilyLink();
