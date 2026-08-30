const firebaseConfig = {
  apiKey: "AIzaSyDfKg319gPVW4c3vZBvgauDkSn_eWc_WTI",
  authDomain: "congo-vibe.firebaseapp.com",
  projectId: "congo-vibe",
  storageBucket: "congo-vibe.firebasestorage.app",
  messagingSenderId: "1080571214757",
  appId: "1:1080571214757:web:b1c7a4fcb2d731418e464c"
};

firebase.initializeApp(firebaseConfig);

const auth = firebase.auth();
const db = firebase.firestore();
const storage = firebase.storage();
