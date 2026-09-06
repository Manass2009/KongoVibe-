/* ==========================================================================
   KONGOVIBE — app.js
   Toute la logique réelle de l'application : Firebase Authentication,
   Firestore (messages, vidéos, likes, commentaires) et appels vidéo WebRTC
   signalés via Firestore. Rien ici n'est simulé : chaque action lit ou
   écrit vraiment dans ton projet Firebase (une fois firebase-config.js
   rempli avec tes propres clés).
   ========================================================================== */

let currentUser = null;       // objet Firebase Auth (uid, email...)
let currentProfile = null;    // doc Firestore users/{uid}
let unsubConversations = null;
let unsubMessages = null;
let unsubIncomingCall = null;
let activeConversationId = null;
let activePeer = null;        // { uid, name, username }
let unsubFeedPosts = null;

/* ---------------------- NAVIGATION BAS DE PAGE ---------------------- */
const navItems = document.querySelectorAll('.nav-item');
const views = document.querySelectorAll('.view');
navItems.forEach(item => {
  item.addEventListener('click', () => {
    navItems.forEach(n => n.classList.remove('active'));
    item.classList.add('active');
    views.forEach(v => v.classList.remove('active'));
    document.getElementById('view-' + item.dataset.view).classList.add('active');
    document.querySelector('.views').scrollTop = 0;
  });
});

/* ---------------------- SERVICE WORKER (hors-ligne) ---------------------- */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(err => {
      console.log("Échec d'enregistrement du service worker :", err);
    });
  });
}

/* ==========================================================================
   AUTHENTIFICATION RÉELLE (Firebase Auth)
   ========================================================================== */
const registerForm   = document.getElementById('register-form');
const loginForm      = document.getElementById('login-form');
const authTitle      = document.getElementById('auth-title');
const authSubtitle   = document.getElementById('auth-subtitle');
const switchToLogin  = document.getElementById('switch-to-login');
const switchToRegister = document.getElementById('switch-to-register');
const usernameError  = document.getElementById('username-error');
const loginError     = document.getElementById('login-error');

switchToLogin.addEventListener('click', () => {
  registerForm.classList.add('auth-hidden');
  loginForm.classList.remove('auth-hidden');
  switchToLogin.classList.add('auth-hidden');
  switchToRegister.classList.remove('auth-hidden');
  authTitle.textContent = 'Content de te revoir';
  authSubtitle.textContent = 'Connecte-toi pour retrouver tes messages et tes vidéos.';
});
switchToRegister.addEventListener('click', () => {
  loginForm.classList.add('auth-hidden');
  registerForm.classList.remove('auth-hidden');
  switchToRegister.classList.add('auth-hidden');
  switchToLogin.classList.remove('auth-hidden');
  authTitle.textContent = 'Créer ton compte';
  authSubtitle.textContent = 'Rejoins KongoVibe pour parler, appeler, créer et suivre tes communautés.';
});

function normalizeUsername(u){
  return u.trim().toLowerCase().replace(/[^a-z0-9_.]/g, '_');
}

function normalizePhone(p){
  return p.trim().replace(/[^0-9+]/g, '');
}

// Firebase Authentication a besoin techniquement d'une adresse e-mail.
// On la fabrique à partir du NOM D'UTILISATEUR (unique) plutôt que du
// numéro de téléphone — ça permet à un même numéro d'être utilisé sur
// plusieurs comptes différents, utile pour tester avec un seul téléphone.
// Le numéro est stocké séparément, juste comme information de profil.
function usernameToInternalEmail(username){
  return username + '@kongovibe.local';
}

// --- Inscription ---
registerForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const submitBtn = registerForm.querySelector('.auth-submit');
  const name = document.getElementById('reg-name').value.trim();
  const username = normalizeUsername(document.getElementById('reg-username').value);
  const phone = normalizePhone(document.getElementById('reg-contact').value);
  const internalEmail = usernameToInternalEmail(username);
  const password = document.getElementById('reg-password').value;
  usernameError.style.display = 'none';

  if(!username){ return; }
  submitBtn.textContent = 'Création en cours…';

  try{
    // Le nom d'utilisateur doit être unique : on vérifie dans Firestore
    const takenDoc = await db.collection('usernames').doc(username).get();
    if(takenDoc.exists){
      usernameError.style.display = 'block';
      submitBtn.textContent = 'Créer mon compte';
      return;
    }

    const cred = await auth.createUserWithEmailAndPassword(internalEmail, password);
    const uid = cred.user.uid;

    const profile = {
      uid, name, username, phone,
      email: internalEmail, // usage interne uniquement, jamais affiché
      photo: '', // rempli plus tard si la personne ajoute une photo
      bio: '',
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    };
    await db.collection('users').doc(uid).set(profile);
    await db.collection('usernames').doc(username).set({ uid });

  } catch(err){
    alert(readableAuthError(err));
  } finally {
    submitBtn.textContent = 'Créer mon compte';
  }
});

// --- Connexion ---
loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const submitBtn = loginForm.querySelector('.auth-submit');
  const usernameOrEmail = document.getElementById('log-username').value.trim();
  const password = document.getElementById('log-password').value;
  loginError.style.display = 'none';
  submitBtn.textContent = 'Connexion en cours…';

  try{
    let email;
    if(usernameOrEmail.includes('@')){
      // compte créé avec l'ancien système (e-mail direct)
      email = usernameOrEmail;
    } else {
      // saisi comme nom d'utilisateur : on résout via Firestore
      // (le numéro de téléphone n'est plus utilisable pour se connecter,
      // car plusieurs comptes peuvent maintenant partager le même numéro)
      const uDoc = await db.collection('usernames').doc(normalizeUsername(usernameOrEmail)).get();
      if(!uDoc.exists){ throw { code: 'auth/user-not-found' }; }
      const userDoc = await db.collection('users').doc(uDoc.data().uid).get();
      email = userDoc.data().email;
    }
    await auth.signInWithEmailAndPassword(email, password);
  } catch(err){
    loginError.textContent = readableAuthError(err);
    loginError.style.display = 'block';
  } finally {
    submitBtn.textContent = 'Se connecter';
  }
});

function readableAuthError(err){
  const map = {
    'auth/email-already-in-use': 'Cette adresse e-mail est déjà utilisée.',
    'auth/invalid-email': "Adresse e-mail invalide.",
    'auth/weak-password': 'Mot de passe trop faible (6 caractères minimum).',
    'auth/user-not-found': "Aucun compte ne correspond à ces identifiants.",
    'auth/wrong-password': 'Mot de passe incorrect.',
    'auth/invalid-credential': 'Identifiants incorrects.',
    'auth/network-request-failed': 'Connexion réseau impossible. Vérifie ta connexion.'
  };
  return map[err.code] || ("Erreur : " + (err.message || err.code || 'inconnue'));
}

// --- Déconnexion ---
document.getElementById('logout-btn').addEventListener('click', () => {
  auth.signOut();
});

// --- Écouteur central : connecté / déconnecté ---
auth.onAuthStateChanged(async (user) => {
  document.getElementById('splash-screen').classList.add('hide');

  if(user){
    currentUser = user;
    const doc = await db.collection('users').doc(user.uid).get();
    currentProfile = doc.exists ? doc.data() : { name: user.email, username: user.email };
    applyProfile(currentProfile);
    document.getElementById('auth-screen').classList.remove('show');
    startConversationsListener();
    startFeedListener();
    listenForIncomingCalls();
  } else {
    currentUser = null;
    currentProfile = null;
    if(unsubConversations) unsubConversations();
    if(unsubFeedPosts) unsubFeedPosts();
    if(unsubIncomingCall) unsubIncomingCall();
    document.getElementById('auth-screen').classList.add('show');
  }
});

function applyProfile(profile){
  const nameEl = document.getElementById('profile-name');
  const handleEl = document.getElementById('profile-handle');
  if(nameEl) nameEl.textContent = profile.name;
  if(handleEl) handleEl.textContent = '@' + profile.username;

  const img = document.getElementById('profile-avatar-img');
  const fallback = document.getElementById('profile-avatar-fallback');
  if(profile.photo){
    img.src = profile.photo;
    img.style.display = 'block';
    fallback.style.display = 'none';
  } else {
    img.style.display = 'none';
    fallback.style.display = 'flex';
  }
}

/* ==========================================================================
   PHOTO DE PROFIL — redimensionnée sur l'appareil, stockée directement
   dans Firestore (en base64). Aucun besoin de Firebase Storage ni d'API
   Google séparée : une petite image (mini format) tient largement dans un
   document Firestore, donc ça reste 100% gratuit.
   ========================================================================== */
function resizeImageToBase64(file, maxSize = 200, quality = 0.75){
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        let { width, height } = img;
        // recadrage carré centré
        const side = Math.min(width, height);
        const sx = (width - side) / 2;
        const sy = (height - side) / 2;
        canvas.width = maxSize;
        canvas.height = maxSize;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, sx, sy, side, side, 0, 0, maxSize, maxSize);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.onerror = reject;
      img.src = e.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

document.getElementById('profile-avatar-wrap').addEventListener('click', () => {
  document.getElementById('avatar-file-input').click();
});

document.getElementById('avatar-file-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if(!file || !currentUser) return;
  try{
    const dataUrl = await resizeImageToBase64(file);
    await db.collection('users').doc(currentUser.uid).update({ photo: dataUrl });
    currentProfile.photo = dataUrl;
    applyProfile(currentProfile);
  } catch(err){
    alert("Impossible de charger cette image : " + err.message);
  }
});

/* ==========================================================================
   MESSAGERIE RÉELLE (Firestore, temps réel)
   ========================================================================== */
function conversationId(uidA, uidB){
  return [uidA, uidB].sort().join('_');
}

// --- Recherche d'un utilisateur pour démarrer une conversation ---
// Recherche par PRÉFIXE sur le nom d'utilisateur (pas besoin de taper le
// nom exact en entier), avec plusieurs résultats possibles, en temps réel
// pendant la frappe.
let searchDebounce = null;

async function runUserSearch(){
  const input = document.getElementById('dm-search-input');
  const resultsBox = document.getElementById('dm-search-results');
  const query = normalizeUsername(input.value);
  if(!query){ resultsBox.innerHTML = ''; return; }

  resultsBox.innerHTML = '<div class="meta" style="padding:10px 4px;">Recherche…</div>';

  try{
    const snap = await db.collection('users')
      .where('username', '>=', query)
      .where('username', '<=', query + '\uf8ff')
      .limit(8)
      .get();

    const matches = snap.docs.filter(d => d.data().uid !== currentUser.uid);

    if(matches.length === 0){
      resultsBox.innerHTML = '<div class="meta" style="padding:10px 4px;">Aucun nom d\'utilisateur ne commence par « ' + escapeHtml(query) + ' ». Vérifie l\'orthographe exacte de son nom d\'utilisateur (pas son nom complet).</div>';
      return;
    }

    resultsBox.innerHTML = '';
    matches.forEach(doc => {
      const peer = doc.data();
      const row = document.createElement('div');
      row.className = 'conv';
      row.innerHTML = `
        <div class="avatar">${avatarHtml(peer.photo)}</div>
        <div class="conv-info">
          <div class="conv-top"><span class="who">${escapeHtml(peer.name)}</span></div>
          <div class="conv-sub"><p>@${escapeHtml(peer.username)}</p></div>
        </div>`;
      row.addEventListener('click', () => {
        openChatThread({ uid: peer.uid, name: peer.name, username: peer.username, photo: peer.photo || '' });
        resultsBox.innerHTML = '';
        input.value = '';
      });
      resultsBox.appendChild(row);
    });
  } catch(err){
    console.error('Recherche:', err);
    resultsBox.innerHTML = '<div class="meta" style="padding:10px 4px; color:var(--magenta);">Erreur de recherche : ' + escapeHtml(err.message) + '</div>';
  }
}

document.getElementById('dm-search-btn').addEventListener('click', runUserSearch);
document.getElementById('dm-search-input').addEventListener('input', () => {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(runUserSearch, 350);
});

// --- Liste des conversations, en temps réel ---
let knownLastMessageAt = {}; // pour détecter les VRAIS nouveaux messages (notifications)
let feedStartedAt = Date.now();

function startConversationsListener(){
  const list = document.getElementById('conversations-list');
  list.innerHTML = '<div class="meta" style="padding:14px 4px;">Chargement de tes conversations…</div>';
  unsubConversations = db.collection('conversations')
    .where('members', 'array-contains', currentUser.uid)
    .onSnapshot(snap => {
      if(snap.empty){
        list.innerHTML = '<div class="meta" style="padding:14px 4px;">Aucune conversation pour l\'instant — cherche un nom d\'utilisateur ci-dessus pour démarrer.</div>';
        return;
      }
      // Tri côté client par date du dernier message (évite d'avoir besoin
      // d'un index composite Firestore pour where + orderBy combinés)
      const docs = snap.docs.slice().sort((a, b) => {
        const ta = a.data().lastMessageAt ? a.data().lastMessageAt.toMillis() : 0;
        const tb = b.data().lastMessageAt ? b.data().lastMessageAt.toMillis() : 0;
        return tb - ta;
      });
      list.innerHTML = '';
      docs.forEach(doc => {
        const conv = doc.data();
        const peerUid = conv.members.find(m => m !== currentUser.uid);
        const peerName = conv.memberNames ? conv.memberNames[peerUid] : 'Utilisateur';
        const peerUsername = conv.memberUsernames ? conv.memberUsernames[peerUid] : '';
        const peerPhoto = conv.memberPhotos ? conv.memberPhotos[peerUid] : '';
        const row = document.createElement('div');
        row.className = 'conv';
        row.innerHTML = `
          <div class="avatar">${avatarHtml(peerPhoto)}</div>
          <div class="conv-info">
            <div class="conv-top"><span class="who">${escapeHtml(peerName)}</span><span class="time">${formatTime(conv.lastMessageAt)}</span></div>
            <div class="conv-sub"><p>${escapeHtml(conv.lastMessage || '')}</p></div>
          </div>`;
        row.addEventListener('click', () => openChatThread({ uid: peerUid, name: peerName, username: peerUsername, photo: peerPhoto }));
        list.appendChild(row);

        // --- Notification réelle + son pour un VRAI nouveau message ---
        const ts = conv.lastMessageAt ? conv.lastMessageAt.toMillis() : 0;
        const previous = knownLastMessageAt[doc.id];
        const isNewIncoming = conv.lastSenderId && conv.lastSenderId !== currentUser.uid
          && ts > feedStartedAt
          && previous !== undefined && ts > previous
          && activeConversationId !== doc.id; // pas de notif si le fil est déjà ouvert
        if(isNewIncoming){
          notifyNewMessage(peerName, conv.lastMessage || 'Nouveau message');
        }
        knownLastMessageAt[doc.id] = ts;
      });
    }, err => {
      console.error('Conversations:', err);
      list.innerHTML = '<div class="meta" style="padding:14px 4px; color:var(--magenta);">Erreur de chargement des conversations : ' + escapeHtml(err.message) + '</div>';
    });
}

// --- Ouvrir un fil de discussion ---
function openChatThread(peer){
  activePeer = peer;
  activeConversationId = conversationId(currentUser.uid, peer.uid);
  document.getElementById('chat-peer-name').textContent = peer.name;
  document.getElementById('chat-peer-handle').textContent = '@' + peer.username;
  document.getElementById('chat-peer-avatar').innerHTML = avatarHtml(peer.photo);
  document.getElementById('chat-thread-screen').classList.add('show');

  const box = document.getElementById('chat-messages');
  box.innerHTML = '';

  if(unsubMessages) unsubMessages();
  unsubMessages = db.collection('conversations').doc(activeConversationId)
    .collection('messages').orderBy('createdAt', 'asc')
    .onSnapshot(snap => {
      box.innerHTML = '';
      snap.forEach(doc => {
        const m = doc.data();
        const mine = m.senderId === currentUser.uid;
        const bubble = document.createElement('div');
        bubble.style.cssText = `max-width:75%; margin:6px 0; padding:${m.type === 'audio' ? '8px 10px' : '10px 13px'}; border-radius:16px; font-size:13.5px; line-height:1.4; ${mine ? 'margin-left:auto; background:var(--grad-aura); color:#12141c;' : 'background:var(--bg-panel); border:1px solid var(--line);'}`;
        if(m.type === 'audio' && m.audio){
          const audio = document.createElement('audio');
          audio.controls = true;
          audio.src = m.audio;
          audio.style.cssText = 'width:210px; height:34px; display:block;';
          bubble.appendChild(audio);
        } else {
          bubble.textContent = m.text;
        }
        box.appendChild(bubble);
      });
      box.scrollTop = box.scrollHeight;
    }, err => console.error('Messages:', err));
}

document.getElementById('chat-back-btn').addEventListener('click', () => {
  document.getElementById('chat-thread-screen').classList.remove('show');
  activeConversationId = null;
  if(unsubMessages) unsubMessages();
});

async function ensureConversationDoc(){
  const convRef = db.collection('conversations').doc(activeConversationId);
  const convSnap = await convRef.get();
  if(!convSnap.exists){
    await convRef.set({
      members: [currentUser.uid, activePeer.uid],
      memberNames: { [currentUser.uid]: currentProfile.name, [activePeer.uid]: activePeer.name },
      memberUsernames: { [currentUser.uid]: currentProfile.username, [activePeer.uid]: activePeer.username },
      memberPhotos: { [currentUser.uid]: currentProfile.photo || '', [activePeer.uid]: activePeer.photo || '' },
      lastMessage: '', lastMessageAt: firebase.firestore.FieldValue.serverTimestamp(), lastSenderId: currentUser.uid
    });
  }
  return convRef;
}

// --- Envoyer un message texte ---
document.getElementById('chat-send-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = document.getElementById('chat-input');
  const text = input.value.trim();
  if(!text || !activeConversationId) return;
  input.value = '';

  const convRef = await ensureConversationDoc();
  await convRef.update({
    lastMessage: text,
    lastMessageAt: firebase.firestore.FieldValue.serverTimestamp(),
    lastSenderId: currentUser.uid
  });
  await convRef.collection('messages').add({
    senderId: currentUser.uid,
    type: 'text',
    text,
    createdAt: firebase.firestore.FieldValue.serverTimestamp()
  });
});

/* ==========================================================================
   MESSAGES VOCAUX — vrai enregistrement micro, stocké en base64 dans
   Firestore (même principe que les photos), donc gratuit. Limité à 60
   secondes pour rester largement sous la limite de taille d'un document.
   ========================================================================== */
let mediaRecorder = null;
let recordedChunks = [];
let recordingTimer = null;

document.getElementById('chat-mic-btn').addEventListener('click', async () => {
  if(!activeConversationId){ return; }
  if(mediaRecorder && mediaRecorder.state === 'recording'){
    mediaRecorder.stop();
    return;
  }
  try{
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    recordedChunks = [];
    mediaRecorder = new MediaRecorder(stream);
    mediaRecorder.ondataavailable = (e) => { if(e.data.size > 0) recordedChunks.push(e.data); };
    mediaRecorder.onstop = async () => {
      stream.getTracks().forEach(t => t.stop());
      clearTimeout(recordingTimer);
      document.getElementById('recording-indicator').style.display = 'none';
      document.getElementById('chat-mic-btn').style.color = '';

      const blob = new Blob(recordedChunks, { type: 'audio/webm' });
      const audioBase64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });

      const convRef = await ensureConversationDoc();
      await convRef.update({
        lastMessage: '🎤 Message vocal',
        lastMessageAt: firebase.firestore.FieldValue.serverTimestamp(),
        lastSenderId: currentUser.uid
      });
      await convRef.collection('messages').add({
        senderId: currentUser.uid,
        type: 'audio',
        audio: audioBase64,
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      });
    };
    mediaRecorder.start();
    document.getElementById('recording-indicator').style.display = 'block';
    document.getElementById('chat-mic-btn').style.color = 'var(--magenta)';
    // Coupure automatique à 60s pour rester sous la limite Firestore
    recordingTimer = setTimeout(() => {
      if(mediaRecorder && mediaRecorder.state === 'recording') mediaRecorder.stop();
    }, 60000);
  } catch(err){
    alert("Impossible d'accéder au micro : " + err.message);
  }
});

/* ==========================================================================
   NOTIFICATIONS RÉELLES + SON — tant que l'app est ouverte (même en arrière-
   plan ou dans un autre onglet). Une vraie notification qui réveille le
   téléphone quand l'app est totalement fermée demanderait un serveur
   d'envoi (Firebase Cloud Messaging + Cloud Functions), qui exige le
   forfait payant — donc pas inclus ici pour rester gratuit.
   ========================================================================== */
if('Notification' in window && Notification.permission === 'default'){
  // On demande la permission juste après la connexion, une seule fois
  Notification.requestPermission().catch(()=>{});
}

// Petit son de notification généré directement (pas de fichier à héberger)
function playNotificationSound(){
  try{
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(880, ctx.currentTime);
    o.frequency.setValueAtTime(660, ctx.currentTime + 0.09);
    g.gain.setValueAtTime(0.18, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
    o.connect(g); g.connect(ctx.destination);
    o.start(); o.stop(ctx.currentTime + 0.35);
  } catch(e){ /* audio non disponible, on ignore */ }
}

function notifyNewMessage(fromName, preview){
  playNotificationSound();
  if('Notification' in window && Notification.permission === 'granted'){
    try{
      new Notification(fromName, { body: preview, icon: 'logo.jpg' });
    } catch(e){ /* certains navigateurs mobiles limitent les notifications web */ }
  }
}

/* ==========================================================================
   APPELS RÉELS — WebRTC signalé via Firestore (vidéo ET audio)
   (Serveurs STUN publics uniquement : les appels peuvent échouer sur
   certains réseaux 4G/CGNAT très restrictifs sans serveur TURN.)
   ========================================================================== */
const rtcConfig = {
  iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }]
};
let peerConnection = null;
let localStream = null;

document.getElementById('chat-call-btn').addEventListener('click', () => startCall('video'));
document.getElementById('chat-audio-call-btn').addEventListener('click', () => startCall('audio'));
document.getElementById('hangup-btn').addEventListener('click', () => endCall());

async function startCall(callType){
  if(!activePeer) return;
  const convRef = await ensureConversationDoc();
  const callId = 'call_' + conversationId(currentUser.uid, activePeer.uid) + '_' + Date.now();

  // IMPORTANT : on crée d'abord l'offre WebRTC et on l'écrit dans Firestore
  // AVANT de signaler l'appel à l'autre personne — sinon elle peut essayer
  // de répondre à une offre qui n'existe pas encore (c'était le bug qui
  // empêchait la vidéo/l'audio d'arriver jusqu'à l'autre personne).
  await openCallScreen(callId, true, callType);

  await convRef.update({
    activeCallId: callId,
    activeCallFrom: currentUser.uid,
    activeCallType: callType
  });
}

function listenForIncomingCalls(){
  unsubIncomingCall = db.collection('conversations')
    .where('members', 'array-contains', currentUser.uid)
    .onSnapshot(snap => {
      snap.docChanges().forEach(change => {
        const conv = change.data();
        if(conv.activeCallId && conv.activeCallFrom !== currentUser.uid && !document.getElementById('call-screen').classList.contains('show')){
          const peerUid = conv.members.find(m => m !== currentUser.uid);
          const callType = conv.activeCallType || 'video';
          const accept = confirm(`Appel ${callType === 'audio' ? 'audio' : 'vidéo'} entrant de ${conv.memberNames[peerUid]}. Répondre ?`);
          activePeer = {
            uid: peerUid,
            name: conv.memberNames[peerUid],
            username: conv.memberUsernames[peerUid],
            photo: conv.memberPhotos ? conv.memberPhotos[peerUid] : ''
          };
          activeConversationId = change.doc.id;
          if(accept){
            openCallScreen(conv.activeCallId, false, callType);
          } else {
            db.collection('conversations').doc(change.doc.id).update({ activeCallId: firebase.firestore.FieldValue.delete() });
          }
        }
      });
    });
}

async function openCallScreen(callId, isCaller, callType){
  document.getElementById('call-screen').classList.add('show');
  document.getElementById('call-peer-name').textContent = activePeer.name;
  document.getElementById('call-status-label').textContent = callType === 'audio' ? 'Appel audio en cours…' : 'Appel vidéo en cours…';

  const remoteVideoEl = document.getElementById('remote-video');
  const localVideoEl = document.getElementById('local-video');
  const audioAvatar = document.getElementById('audio-call-avatar');
  const toggleCamBtn = document.getElementById('toggle-cam-btn');

  if(callType === 'audio'){
    audioAvatar.style.display = 'flex';
    remoteVideoEl.style.display = 'none';
    localVideoEl.style.display = 'none';
    toggleCamBtn.style.display = 'none';
  } else {
    audioAvatar.style.display = 'none';
    remoteVideoEl.style.display = 'block';
    localVideoEl.style.display = 'block';
    toggleCamBtn.style.display = 'flex';
  }

  localStream = await navigator.mediaDevices.getUserMedia({
    video: callType === 'video',
    audio: true
  });
  localVideoEl.srcObject = localStream;

  peerConnection = new RTCPeerConnection(rtcConfig);
  localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));

  const remoteStream = new MediaStream();
  remoteVideoEl.srcObject = remoteStream;
  peerConnection.ontrack = (event) => {
    event.streams[0].getTracks().forEach(track => remoteStream.addTrack(track));
  };

  const callDoc = db.collection('calls').doc(callId);
  const callerCandidates = callDoc.collection('callerCandidates');
  const calleeCandidates = callDoc.collection('calleeCandidates');

  if(isCaller){
    peerConnection.onicecandidate = (event) => {
      if(event.candidate) callerCandidates.add(event.candidate.toJSON());
    };
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    await callDoc.set({ offer: { type: offer.type, sdp: offer.sdp }, callType });

    callDoc.onSnapshot(async (snap) => {
      const data = snap.data();
      if(data && data.answer && peerConnection.currentRemoteDescription === null){
        await peerConnection.setRemoteDescription(new RTCSessionDescription(data.answer));
      }
    });
    calleeCandidates.onSnapshot(snap => {
      snap.docChanges().forEach(change => {
        if(change.type === 'added') peerConnection.addIceCandidate(new RTCIceCandidate(change.doc.data()));
      });
    });
  } else {
    peerConnection.onicecandidate = (event) => {
      if(event.candidate) calleeCandidates.add(event.candidate.toJSON());
    };
    const snap = await callDoc.get();
    const data = snap.data();
    if(!data || !data.offer){
      alert("L'appel n'est plus disponible (annulé par l'autre personne).");
      endCall();
      return;
    }
    await peerConnection.setRemoteDescription(new RTCSessionDescription(data.offer));
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    await callDoc.update({ answer: { type: answer.type, sdp: answer.sdp } });

    callerCandidates.onSnapshot(snap => {
      snap.docChanges().forEach(change => {
        if(change.type === 'added') peerConnection.addIceCandidate(new RTCIceCandidate(change.doc.data()));
      });
    });
  }
}

document.getElementById('toggle-mic-btn').addEventListener('click', (e) => {
  if(!localStream) return;
  const track = localStream.getAudioTracks()[0];
  track.enabled = !track.enabled;
  e.currentTarget.style.opacity = track.enabled ? '1' : '0.4';
});
document.getElementById('toggle-cam-btn').addEventListener('click', (e) => {
  if(!localStream) return;
  const track = localStream.getVideoTracks()[0];
  if(!track) return;
  track.enabled = !track.enabled;
  e.currentTarget.style.opacity = track.enabled ? '1' : '0.4';
});

function endCall(){
  if(peerConnection) peerConnection.close();
  if(localStream) localStream.getTracks().forEach(t => t.stop());
  peerConnection = null; localStream = null;
  document.getElementById('call-screen').classList.remove('show');
  if(activeConversationId){
    db.collection('conversations').doc(activeConversationId).update({
      activeCallId: firebase.firestore.FieldValue.delete(),
      activeCallFrom: firebase.firestore.FieldValue.delete(),
      activeCallType: firebase.firestore.FieldValue.delete()
    }).catch(()=>{});
  }
}

/* ---------------------- UTILITAIRES ---------------------- */
function avatarHtml(photo){
  if(photo){
    return `<img class="avatar-photo" src="${photo}" alt="">`;
  }
  return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#9AA1B4" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-3.5 3.6-6 8-6s8 2.5 8 6"/></svg>`;
}

function escapeHtml(str){
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}
function formatTime(ts){
  if(!ts || !ts.toDate) return '';
  const d = ts.toDate();
  return d.getHours().toString().padStart(2,'0') + ':' + d.getMinutes().toString().padStart(2,'0');
}

/* ==========================================================================
   FIL DE PUBLICATIONS — photos réelles + likes réels
   Aucune simulation : les photos sont redimensionnées/compressées sur le
   téléphone puis stockées directement dans Firestore (comme la photo de
   profil), donc pas besoin de Firebase Storage payant. Les likes et le
   nombre de commentaires sont de vrais compteurs partagés entre tous les
   utilisateurs, mis à jour en temps réel.
   ========================================================================== */
function resizeImageKeepAspect(file, maxDim = 900, quality = 0.72){
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if(width >= height){
          if(width > maxDim){ height = Math.round(height * (maxDim / width)); width = maxDim; }
        } else {
          if(height > maxDim){ width = Math.round(width * (maxDim / height)); height = maxDim; }
        }
        const canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.onerror = reject;
      img.src = e.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// Compresse jusqu'à tenir sous la limite de taille d'un document Firestore
async function compressPostImage(file){
  const MAX_CHARS = 850000; // marge de sécurité sous la limite de 1 Mo de Firestore
  let quality = 0.72;
  let dataUrl = await resizeImageKeepAspect(file, 900, quality);
  while(dataUrl.length > MAX_CHARS && quality > 0.3){
    quality -= 0.12;
    dataUrl = await resizeImageKeepAspect(file, 900, quality);
  }
  if(dataUrl.length > MAX_CHARS){
    dataUrl = await resizeImageKeepAspect(file, 650, 0.5);
  }
  return dataUrl;
}

let selectedPostFile = null;

document.getElementById('post-picker').addEventListener('click', () => {
  document.getElementById('post-file-input').click();
});

document.getElementById('post-file-input').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if(!file) return;
  selectedPostFile = file;
  const preview = document.getElementById('post-preview');
  preview.src = URL.createObjectURL(file);
  preview.style.display = 'block';
  document.getElementById('post-picker').textContent = '📷 Changer la photo';
});

// --- Ouverture / fermeture de l'écran de publication ---
document.getElementById('open-create-post').addEventListener('click', () => {
  document.getElementById('create-post-screen').classList.add('show');
});
document.getElementById('create-post-back').addEventListener('click', () => {
  document.getElementById('create-post-screen').classList.remove('show');
});

document.getElementById('post-publish-btn').addEventListener('click', async () => {
  const statusEl = document.getElementById('post-status');
  const caption = document.getElementById('post-caption').value.trim();

  if(!selectedPostFile){ alert('Choisis une photo à publier.'); return; }
  if(!currentUser){ alert('Connecte-toi pour publier.'); return; }

  statusEl.style.display = 'block';
  statusEl.textContent = 'Préparation de la photo…';

  try{
    const photo = await compressPostImage(selectedPostFile);
    statusEl.textContent = 'Publication…';

    await db.collection('posts').add({
      uid: currentUser.uid,
      name: currentProfile.name,
      username: currentProfile.username,
      authorPhoto: currentProfile.photo || '',
      photo, caption,
      likes: 0, likedBy: [], commentsCount: 0,
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });

    // reset du formulaire
    selectedPostFile = null;
    document.getElementById('post-file-input').value = '';
    document.getElementById('post-caption').value = '';
    document.getElementById('post-preview').style.display = 'none';
    document.getElementById('post-picker').textContent = '📷 Choisir une photo à publier';
    statusEl.style.display = 'none';
    document.getElementById('create-post-screen').classList.remove('show');
  } catch(err){
    statusEl.textContent = 'Erreur : ' + err.message;
  }
});

function startFeedListener(){
  const feed = document.getElementById('feed-posts');
  unsubFeedPosts = db.collection('posts').orderBy('createdAt', 'desc').limit(30)
    .onSnapshot(snap => {
      if(snap.empty){
        feed.innerHTML = '<div class="meta" style="padding:20px 4px;">Aucune publication pour l\'instant — sois le premier ✦</div>';
        return;
      }
      feed.innerHTML = '';
      snap.forEach(doc => {
        const post = doc.data();
        const postId = doc.id;
        const liked = currentUser && post.likedBy && post.likedBy.includes(currentUser.uid);
        const card = document.createElement('div');
        card.className = 'post-card';
        card.innerHTML = `
          <div class="post-head">
            <div class="avatar">${avatarHtml(post.authorPhoto)}</div>
            <div>
              <div class="who">${escapeHtml(post.name || post.username)}</div>
              <div class="meta">@${escapeHtml(post.username)} · ${formatTime(post.createdAt)}</div>
            </div>
          </div>
          <img class="post-photo" src="${post.photo}" alt="">
          ${post.caption ? `<div class="post-caption">${escapeHtml(post.caption)}</div>` : ''}
          <div class="post-actions">
            <div class="post-act like-btn ${liked ? 'liked' : ''}">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="${liked ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.6l-1-1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8z"/></svg>
              <span>${post.likes || 0}</span>
            </div>
            <div class="post-act comment-btn">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>
              <span>${post.commentsCount || 0}</span>
            </div>
          </div>
          <div class="comments-section" id="comments-${postId}">
            <div class="comments-list" id="comments-list-${postId}"></div>
            <div class="comment-form">
              <input type="text" id="comment-input-${postId}" placeholder="Écrire un commentaire…">
              <button type="button" class="send-comment-btn"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg></button>
            </div>
          </div>`;
        card.querySelector('.like-btn').addEventListener('click', () => toggleLike(postId, post));
        card.querySelector('.comment-btn').addEventListener('click', () => toggleComments(postId));
        card.querySelector('.send-comment-btn').addEventListener('click', () => submitComment(postId));
        card.querySelector(`#comment-input-${postId}`).addEventListener('keydown', (e) => {
          if(e.key === 'Enter'){ e.preventDefault(); submitComment(postId); }
        });
        feed.appendChild(card);
      });
    }, err => {
      console.error('Fil:', err);
      feed.innerHTML = '<div class="meta" style="padding:14px 4px; color:var(--magenta);">Erreur de chargement du fil : ' + escapeHtml(err.message) + '</div>';
    });
}

async function toggleLike(postId, post){
  if(!currentUser) return;
  const ref = db.collection('posts').doc(postId);
  const liked = post.likedBy && post.likedBy.includes(currentUser.uid);
  if(liked){
    await ref.update({
      likes: firebase.firestore.FieldValue.increment(-1),
      likedBy: firebase.firestore.FieldValue.arrayRemove(currentUser.uid)
    });
  } else {
    await ref.update({
      likes: firebase.firestore.FieldValue.increment(1),
      likedBy: firebase.firestore.FieldValue.arrayUnion(currentUser.uid)
    });
  }
}

/* ==========================================================================
   COMMENTAIRES — section intégrée dans la publication, comme Facebook,
   plus de fenêtre système moche (prompt/confirm du navigateur).
   ========================================================================== */
const openCommentSections = {};

function toggleComments(postId){
  const section = document.getElementById(`comments-${postId}`);
  const isOpen = section.classList.toggle('open');
  if(isOpen && !openCommentSections[postId]){
    openCommentSections[postId] = db.collection('posts').doc(postId).collection('comments')
      .orderBy('createdAt', 'asc')
      .onSnapshot(snap => {
        const list = document.getElementById(`comments-list-${postId}`);
        if(!list) return;
        list.innerHTML = '';
        snap.forEach(doc => {
          const c = doc.data();
          const line = document.createElement('div');
          line.className = 'comment-line';
          line.innerHTML = `<b>@${escapeHtml(c.username)}</b><p>${escapeHtml(c.text)}</p>`;
          list.appendChild(line);
        });
      });
  }
}

async function submitComment(postId){
  const input = document.getElementById(`comment-input-${postId}`);
  const text = input.value.trim();
  if(!text) return;
  input.value = '';
  await db.collection('posts').doc(postId).collection('comments').add({
    uid: currentUser.uid,
    username: currentProfile.username,
    text,
    createdAt: firebase.firestore.FieldValue.serverTimestamp()
  });
  await db.collection('posts').doc(postId).update({
    commentsCount: firebase.firestore.FieldValue.increment(1)
  });
}
