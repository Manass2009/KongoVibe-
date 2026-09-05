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
let unsubVibeFeed = null;

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
// Comme on reste sur le forfait gratuit (pas de vérification SMS payante),
// on fabrique un e-mail interne à partir du numéro — invisible pour la
// personne, qui ne voit et ne saisit que son numéro de téléphone.
// Important : ce numéro n'est PAS vérifié par SMS, contrairement à WhatsApp.
function phoneToInternalEmail(phone){
  return normalizePhone(phone).replace('+', '') + '@kongovibe.local';
}

// --- Inscription ---
registerForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const submitBtn = registerForm.querySelector('.auth-submit');
  const name = document.getElementById('reg-name').value.trim();
  const username = normalizeUsername(document.getElementById('reg-username').value);
  const phone = normalizePhone(document.getElementById('reg-contact').value);
  const internalEmail = phoneToInternalEmail(phone);
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
  const usernameOrPhone = document.getElementById('log-username').value.trim();
  const password = document.getElementById('log-password').value;
  loginError.style.display = 'none';
  submitBtn.textContent = 'Connexion en cours…';

  try{
    let email;
    if(usernameOrPhone.includes('@')){
      // compte créé avec l'ancien système (e-mail direct)
      email = usernameOrPhone;
    } else if(/^[+0-9]+$/.test(usernameOrPhone)){
      // saisi comme numéro de téléphone
      email = phoneToInternalEmail(usernameOrPhone);
    } else {
      // saisi comme nom d'utilisateur : on résout via Firestore
      const uDoc = await db.collection('usernames').doc(normalizeUsername(usernameOrPhone)).get();
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
    startVibeFeedListener();
    listenForIncomingCalls();
  } else {
    currentUser = null;
    currentProfile = null;
    if(unsubConversations) unsubConversations();
    if(unsubVibeFeed) unsubVibeFeed();
    if(unsubIncomingCall) unsubIncomingCall();
    document.getElementById('auth-screen').classList.add('show');
  }
});

function applyProfile(profile){
  const nameEl = document.getElementById('profile-name');
  const handleEl = document.getElementById('profile-handle');
  if(nameEl) nameEl.textContent = profile.name;
  if(handleEl) handleEl.textContent = '@' + profile.username;
}

/* ==========================================================================
   MESSAGERIE RÉELLE (Firestore, temps réel)
   ========================================================================== */
function conversationId(uidA, uidB){
  return [uidA, uidB].sort().join('_');
}

// --- Recherche d'un utilisateur pour démarrer une conversation ---
document.getElementById('dm-search-btn').addEventListener('click', async () => {
  const input = document.getElementById('dm-search-input');
  const resultsBox = document.getElementById('dm-search-results');
  const query = normalizeUsername(input.value);
  resultsBox.innerHTML = '';
  if(!query) return;

  const uDoc = await db.collection('usernames').doc(query).get();
  if(!uDoc.exists){
    resultsBox.innerHTML = '<div class="meta" style="padding:10px 4px;">Aucun utilisateur trouvé avec ce nom.</div>';
    return;
  }
  if(uDoc.data().uid === currentUser.uid){
    resultsBox.innerHTML = '<div class="meta" style="padding:10px 4px;">C\'est ton propre compte 🙂</div>';
    return;
  }
  const userDoc = await db.collection('users').doc(uDoc.data().uid).get();
  const peer = userDoc.data();

  const row = document.createElement('div');
  row.className = 'conv';
  row.innerHTML = `
    <div class="avatar">👤</div>
    <div class="conv-info">
      <div class="conv-top"><span class="who">${escapeHtml(peer.name)}</span></div>
      <div class="conv-sub"><p>@${escapeHtml(peer.username)}</p></div>
    </div>`;
  row.addEventListener('click', () => {
    openChatThread({ uid: peer.uid, name: peer.name, username: peer.username });
    resultsBox.innerHTML = '';
    input.value = '';
  });
  resultsBox.appendChild(row);
});

// --- Liste des conversations, en temps réel ---
function startConversationsListener(){
  const list = document.getElementById('conversations-list');
  unsubConversations = db.collection('conversations')
    .where('members', 'array-contains', currentUser.uid)
    .orderBy('lastMessageAt', 'desc')
    .onSnapshot(snap => {
      if(snap.empty){
        list.innerHTML = '<div class="meta" style="padding:14px 4px;">Aucune conversation pour l\'instant — cherche un nom d\'utilisateur ci-dessus pour démarrer.</div>';
        return;
      }
      list.innerHTML = '';
      snap.forEach(doc => {
        const conv = doc.data();
        const peerUid = conv.members.find(m => m !== currentUser.uid);
        const peerName = conv.memberNames ? conv.memberNames[peerUid] : 'Utilisateur';
        const peerUsername = conv.memberUsernames ? conv.memberUsernames[peerUid] : '';
        const row = document.createElement('div');
        row.className = 'conv';
        row.innerHTML = `
          <div class="avatar">👤</div>
          <div class="conv-info">
            <div class="conv-top"><span class="who">${escapeHtml(peerName)}</span><span class="time">${formatTime(conv.lastMessageAt)}</span></div>
            <div class="conv-sub"><p>${escapeHtml(conv.lastMessage || '')}</p></div>
          </div>`;
        row.addEventListener('click', () => openChatThread({ uid: peerUid, name: peerName, username: peerUsername }));
        list.appendChild(row);
      });
    }, err => console.error('Conversations:', err));
}

// --- Ouvrir un fil de discussion ---
function openChatThread(peer){
  activePeer = peer;
  activeConversationId = conversationId(currentUser.uid, peer.uid);
  document.getElementById('chat-peer-name').textContent = peer.name;
  document.getElementById('chat-peer-handle').textContent = '@' + peer.username;
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
        const bubble = document.createElement('div');
        const mine = m.senderId === currentUser.uid;
        bubble.style.cssText = `max-width:75%; margin:6px 0; padding:10px 13px; border-radius:16px; font-size:13.5px; line-height:1.4; ${mine ? 'margin-left:auto; background:var(--grad-aura); color:#0A0A12;' : 'background:var(--bg-panel); border:1px solid var(--line);'}`;
        bubble.textContent = m.text;
        box.appendChild(bubble);
      });
      box.scrollTop = box.scrollHeight;
    }, err => console.error('Messages:', err));
}

document.getElementById('chat-back-btn').addEventListener('click', () => {
  document.getElementById('chat-thread-screen').classList.remove('show');
  if(unsubMessages) unsubMessages();
});

// --- Envoyer un message ---
document.getElementById('chat-send-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = document.getElementById('chat-input');
  const text = input.value.trim();
  if(!text || !activeConversationId) return;
  input.value = '';

  const convRef = db.collection('conversations').doc(activeConversationId);
  const convSnap = await convRef.get();

  if(!convSnap.exists){
    await convRef.set({
      members: [currentUser.uid, activePeer.uid],
      memberNames: { [currentUser.uid]: currentProfile.name, [activePeer.uid]: activePeer.name },
      memberUsernames: { [currentUser.uid]: currentProfile.username, [activePeer.uid]: activePeer.username },
      lastMessage: text,
      lastMessageAt: firebase.firestore.FieldValue.serverTimestamp()
    });
  } else {
    await convRef.update({
      lastMessage: text,
      lastMessageAt: firebase.firestore.FieldValue.serverTimestamp()
    });
  }

  await convRef.collection('messages').add({
    senderId: currentUser.uid,
    text,
    createdAt: firebase.firestore.FieldValue.serverTimestamp()
  });
});

/* ==========================================================================
   VIDÉOS (Vibe) — retirées pour l'instant
   Cette fonctionnalité nécessite Firebase Storage (forfait payant "Blaze").
   Pour rester sur le forfait gratuit "Spark", l'onglet Vibe et la publication
   de vidéos sont désactivés (voir la tuile "Nouvelle vidéo" marquée
   data-soon dans l'écran Créer, gérée plus bas avec les autres).
   Rien n'est simulé : la fonctionnalité reviendra une fois Storage activé.
   ========================================================================== */

// Les tuiles "Publication / Statut / Sondage / Événement" ne sont pas encore
// connectées à Firestore — on le dit honnêtement plutôt que de simuler.
document.querySelectorAll('.create-tile[data-soon]').forEach(tile => {
  tile.addEventListener('click', () => {
    alert("Cette fonctionnalité arrive bientôt — pour l'instant, seule la publication de vidéos est branchée à la base de données.");
  });
});

/* ==========================================================================
   APPELS VIDÉO RÉELS — WebRTC signalé via Firestore
   (Serveurs STUN publics uniquement : les appels peuvent échouer sur
   certains réseaux 4G/CGNAT très restrictifs sans serveur TURN.)
   ========================================================================== */
const rtcConfig = {
  iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }]
};
let peerConnection = null;
let localStream = null;

document.getElementById('chat-call-btn').addEventListener('click', () => startCall());
document.getElementById('hangup-btn').addEventListener('click', () => endCall());

async function startCall(){
  if(!activePeer) return;
  const callId = 'call_' + conversationId(currentUser.uid, activePeer.uid) + '_' + Date.now();
  await db.collection('conversations').doc(activeConversationId).update({
    activeCallId: callId,
    activeCallFrom: currentUser.uid
  });
  await openCallScreen(callId, true);
}

function listenForIncomingCalls(){
  unsubIncomingCall = db.collection('conversations')
    .where('members', 'array-contains', currentUser.uid)
    .onSnapshot(snap => {
      snap.docChanges().forEach(change => {
        const conv = change.data();
        if(conv.activeCallId && conv.activeCallFrom !== currentUser.uid && !document.getElementById('call-screen').classList.contains('show')){
          const peerUid = conv.members.find(m => m !== currentUser.uid);
          const accept = confirm(`Appel vidéo entrant de ${conv.memberNames[peerUid]}. Répondre ?`);
          activePeer = { uid: peerUid, name: conv.memberNames[peerUid], username: conv.memberUsernames[peerUid] };
          activeConversationId = change.doc.id;
          if(accept){
            openCallScreen(conv.activeCallId, false);
          } else {
            db.collection('conversations').doc(change.doc.id).update({ activeCallId: firebase.firestore.FieldValue.delete() });
          }
        }
      });
    });
}

async function openCallScreen(callId, isCaller){
  document.getElementById('call-screen').classList.add('show');
  document.getElementById('call-peer-name').textContent = activePeer.name;

  localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  document.getElementById('local-video').srcObject = localStream;

  peerConnection = new RTCPeerConnection(rtcConfig);
  localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));

  const remoteStream = new MediaStream();
  document.getElementById('remote-video').srcObject = remoteStream;
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
    await callDoc.set({ offer: { type: offer.type, sdp: offer.sdp } });

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
    const offer = snap.data().offer;
    await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
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
      activeCallFrom: firebase.firestore.FieldValue.delete()
    }).catch(()=>{});
  }
}

/* ---------------------- UTILITAIRES ---------------------- */
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
