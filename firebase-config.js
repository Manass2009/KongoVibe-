// ============================================================
// CONFIGURATION FIREBASE — projet "congo-vibe"
// Rempli avec les clés de https://console.firebase.google.com
// (format adapté au SDK "compat" utilisé par app.js — pas le style
// "import" que la console Firebase propose par défaut, qui est
// pour les projets avec un bundler comme React/Vite).
//
// Vérifie que ces 3 services sont bien activés dans la console :
//   - Authentication → Sign-in method → "E-mail/Mot de passe"
//   - Firestore Database → créée
//   - Storage → créé
// ============================================================

const firebaseConfig = {
  apiKey: "AIzaSyDfKg319gPVW4c3vZBvgauDkSn_eWc_WTI",
  authDomain: "congo-vibe.firebaseapp.com",
  projectId: "congo-vibe",
  storageBucket: "congo-vibe.firebasestorage.app",
  messagingSenderId: "1080571214757",
  appId: "1:1080571214757:web:b1c7a4fcb2d731418e464c"
};

firebase.initializeApp(firebaseConfig);

// Instances partagées, utilisées par app.js
const auth = firebase.auth();
const db = firebase.firestore();
const storage = firebase.storage();

