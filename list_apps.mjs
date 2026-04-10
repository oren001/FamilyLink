import { initializeApp } from 'firebase/app';
import { getFirestore, collection, getDocs } from 'firebase/firestore';

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

async function listApps() {
  try {
    const querySnapshot = await getDocs(collection(db, 'apps'));
    querySnapshot.forEach((doc) => {
      console.log(`${doc.id} => ${JSON.stringify(doc.data())}`);
    });
    process.exit(0);
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
}

listApps();
