import { initializeApp } from "firebase/app";
import { getFirestore, collection, doc, setDoc } from "firebase/firestore";
import fs from 'fs';
import path from 'path';

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

const dbPath = path.resolve('data/db.json');
const data = JSON.parse(fs.readFileSync(dbPath, 'utf8'));

async function migrate() {
  console.log('Migrating users...');
  for (const user of data.users) {
    const { id, ...userData } = user;
    // We'll use the numeric ID as string for Firestore doc ID to preserve relations
    await setDoc(doc(db, 'users', String(id)), {
      ...userData,
      online: false
    });
    console.log(`Migrated user: ${userData.username}`);
  }

  console.log('Migrating messages...');
  for (const msg of data.messages) {
    const { id, ...msgData } = msg;
    const chatId = [msgData.fromUserId, msgData.toUserId].sort().join('_');
    await setDoc(doc(db, 'messages', String(id)), {
      ...msgData,
      chatId,
      createdAt: new Date(msgData.createdAt) // Parse to Date
    });
  }

  console.log('Migration complete!');
  process.exit(0);
}

migrate().catch(console.error);
