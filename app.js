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
    startMyPostsListener();
    listenForIncomingCalls();
    startPresence();
    renderBlockedUsersList();
  } else {
    currentUser = null;
    currentProfile = null;
    if(unsubConversations) unsubConversations();
    if(unsubFeedPosts) unsubFeedPosts();
    if(unsubMyPosts) unsubMyPosts();
    if(unsubIncomingCall) unsubIncomingCall();
    stopPresence();
    document.getElementById('auth-screen').classList.add('show');
  }
});

/* ==========================================================================
   PRÉSENCE — en ligne / hors ligne + « vu à... »
   Basé sur Firestore (pas de Realtime Database), donc approximatif en cas
   de fermeture brutale (batterie coupée, app tuée) : mis à jour toutes les
   25s tant que l'app est ouverte, et à la fermeture normale de l'onglet.
   ========================================================================== */
let presenceInterval = null;

function setPresence(online){
  if(!currentUser) return;
  db.collection('users').doc(currentUser.uid).update({
    online, lastSeen: firebase.firestore.FieldValue.serverTimestamp()
  }).catch(()=>{});
}

function startPresence(){
  setPresence(true);
  presenceInterval = setInterval(() => setPresence(true), 25000);
  document.addEventListener('visibilitychange', handleVisibilityChange);
  window.addEventListener('beforeunload', () => setPresence(false));
}
function stopPresence(){
  if(presenceInterval) clearInterval(presenceInterval);
  document.removeEventListener('visibilitychange', handleVisibilityChange);
  setPresence(false);
}
function handleVisibilityChange(){
  setPresence(document.visibilityState === 'visible');
}

function formatLastSeen(ts){
  if(!ts || !ts.toDate) return '';
  const d = ts.toDate();
  const now = Date.now();
  if(now - d.getTime() < 40000) return 'en ligne';
  const hh = d.getHours().toString().padStart(2,'0');
  const mm = d.getMinutes().toString().padStart(2,'0');
  return 'vu à ' + hh + ':' + mm;
}

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

async function renderBlockedUsersList(){
  const list = document.getElementById('blocked-users-list');
  const blocked = (currentProfile && currentProfile.blockedUsers) || [];
  if(blocked.length === 0){
    list.innerHTML = '<div class="meta" style="padding:6px 4px;">Aucun utilisateur bloqué.</div>';
    return;
  }
  list.innerHTML = '<div class="meta" style="padding:6px 4px;">Chargement…</div>';
  const rows = await Promise.all(blocked.map(uid => db.collection('users').doc(uid).get()));
  list.innerHTML = '';
  rows.forEach(doc => {
    if(!doc.exists) return;
    const u = doc.data();
    const row = document.createElement('div');
    row.className = 'conv';
    row.innerHTML = `
      <div class="avatar">${avatarHtml(u.photo)}</div>
      <div class="conv-info">
        <div class="conv-top"><span class="who">${escapeHtml(u.name)}</span></div>
        <div class="conv-sub"><p>@${escapeHtml(u.username)}</p></div>
      </div>
      <div class="btn ghost" style="flex:0 0 auto; padding:8px 12px; font-size:12px;">Débloquer</div>`;
    row.querySelector('.btn').addEventListener('click', async () => {
      await db.collection('users').doc(currentUser.uid).update({
        blockedUsers: firebase.firestore.FieldValue.arrayRemove(u.uid)
      });
      currentProfile.blockedUsers = (currentProfile.blockedUsers || []).filter(x => x !== u.uid);
      renderBlockedUsersList();
    });
    list.appendChild(row);
  });
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

    const myBlocked = currentProfile.blockedUsers || [];
    const matches = snap.docs.filter(d => {
      const u = d.data();
      if(u.uid === currentUser.uid) return false;
      if(myBlocked.includes(u.uid)) return false;
      if((u.blockedUsers || []).includes(currentUser.uid)) return false;
      return true;
    });

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
let unsubPeerPresence = null;
let unsubConvMeta = null;
let peerTypingNow = false;
let peerLastReadMillis = 0;
let lastRenderedMessages = [];
let replyingTo = null;
let peerBlockedList = [];

function openChatThread(peer){
  activePeer = peer;
  activeConversationId = conversationId(currentUser.uid, peer.uid);
  document.getElementById('chat-peer-name').textContent = peer.name;
  document.getElementById('chat-peer-handle').textContent = '@' + peer.username;
  document.getElementById('chat-peer-avatar').innerHTML = avatarHtml(peer.photo);
  document.getElementById('chat-thread-screen').classList.add('show');
  cancelReply();
  document.getElementById('chat-menu-dropdown').style.display = 'none';

  const box = document.getElementById('chat-messages');
  box.innerHTML = '';

  // --- Présence + liste de blocage de la personne en face ---
  if(unsubPeerPresence) unsubPeerPresence();
  unsubPeerPresence = db.collection('users').doc(peer.uid).onSnapshot(doc => {
    const d = doc.data() || {};
    peerBlockedList = d.blockedUsers || [];
    if(!peerTypingNow){
      document.getElementById('chat-peer-handle').textContent = formatLastSeen(d.lastSeen);
    }
  });

  // --- Frappe + accusés de lecture (document de la conversation) ---
  if(unsubConvMeta) unsubConvMeta();
  unsubConvMeta = db.collection('conversations').doc(activeConversationId).onSnapshot(doc => {
    const conv = doc.data();
    if(!conv) return;
    peerTypingNow = !!(conv.typing && conv.typing[peer.uid]);
    document.getElementById('chat-peer-handle').textContent = peerTypingNow
      ? 'en train d\'écrire…'
      : document.getElementById('chat-peer-handle').textContent;
    const peerRead = conv.lastRead && conv.lastRead[peer.uid];
    peerLastReadMillis = peerRead && peerRead.toMillis ? peerRead.toMillis() : 0;
    renderMessages();
  });

  if(unsubMessages) unsubMessages();
  unsubMessages = db.collection('conversations').doc(activeConversationId)
    .collection('messages').orderBy('createdAt', 'asc')
    .onSnapshot(snap => {
      lastRenderedMessages = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      renderMessages();
      markConversationRead();
    }, err => console.error('Messages:', err));
}

function renderMessages(){
  const box = document.getElementById('chat-messages');
  box.innerHTML = '';
  lastRenderedMessages.forEach(m => {
    const mine = m.senderId === currentUser.uid;
    const wrap = document.createElement('div');
    wrap.style.cssText = `display:flex; align-items:flex-end; gap:6px; ${mine ? 'flex-direction:row-reverse;' : ''}`;

    const bubble = document.createElement('div');
    const isMedia = m.type === 'audio' || m.type === 'image' || m.type === 'video';
    bubble.style.cssText = `max-width:100%; margin:4px 0; padding:${isMedia && m.type !== 'audio' ? '4px' : '8px 10px'}; border-radius:16px; font-size:13.5px; line-height:1.4; ${mine ? 'background:var(--grad-aura); color:#12141c;' : 'background:var(--bg-panel); border:1px solid var(--line);'}`;

    if(m.replyTo){
      const quote = document.createElement('div');
      quote.style.cssText = `font-size:11px; opacity:0.75; border-left:2px solid currentColor; padding:2px 0 2px 6px; margin-bottom:5px;`;
      quote.textContent = (m.replyTo.senderName || '') + ' : ' + (m.replyTo.preview || '');
      bubble.appendChild(quote);
    }

    if(m.type === 'audio' && m.audio){
      const audio = document.createElement('audio');
      audio.controls = true;
      audio.src = m.audio;
      audio.style.cssText = 'width:210px; height:34px; display:block;';
      audio.addEventListener('loadedmetadata', () => {
        if(audio.duration === Infinity || isNaN(audio.duration)){
          audio.currentTime = 1e7;
          const fix = () => { audio.currentTime = 0; audio.removeEventListener('timeupdate', fix); };
          audio.addEventListener('timeupdate', fix);
        }
      });
      bubble.appendChild(audio);
    } else if(m.type === 'image' && m.image){
      const img = document.createElement('img');
      img.src = m.image;
      img.style.cssText = 'max-width:220px; border-radius:12px; display:block; cursor:pointer;';
      img.addEventListener('click', () => openLightbox(m.image, 'photo', 'kongovibe-chat'));
      bubble.appendChild(img);
    } else if(m.type === 'video' && m.video){
      const vid = document.createElement('video');
      vid.src = m.video;
      vid.controls = true;
      vid.style.cssText = 'max-width:220px; border-radius:12px; display:block;';
      bubble.appendChild(vid);
    } else {
      const textEl = document.createElement('div');
      textEl.style.padding = isMedia ? '0' : '2px 4px';
      textEl.textContent = m.text;
      bubble.appendChild(textEl);
    }

    if(mine){
      const ticks = document.createElement('div');
      const read = m.createdAt && peerLastReadMillis >= m.createdAt.toMillis();
      ticks.style.cssText = `font-size:10px; text-align:right; margin-top:2px; opacity:0.8; ${read ? 'color:var(--violet);' : ''}`;
      ticks.textContent = read ? '✓✓ Lu' : '✓ Envoyé';
      bubble.appendChild(ticks);
    }

    // --- Actions rapides : répondre / supprimer (les siens) ---
    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex; flex-direction:column; gap:4px; opacity:0.55;';
    const replyBtn = document.createElement('div');
    replyBtn.style.cssText = 'cursor:pointer; font-size:13px;';
    replyBtn.textContent = '↩';
    replyBtn.title = 'Répondre';
    replyBtn.addEventListener('click', () => startReply(m, mine));
    actions.appendChild(replyBtn);
    if(mine){
      const delBtn = document.createElement('div');
      delBtn.style.cssText = 'cursor:pointer; font-size:13px;';
      delBtn.textContent = '🗑';
      delBtn.title = 'Supprimer';
      let confirming = false;
      delBtn.addEventListener('click', () => {
        if(!confirming){
          confirming = true;
          delBtn.textContent = '❗';
          delBtn.style.color = 'var(--magenta)';
          setTimeout(() => { confirming = false; delBtn.textContent = '🗑'; delBtn.style.color = ''; }, 3000);
        } else {
          db.collection('conversations').doc(activeConversationId).collection('messages').doc(m.id).delete();
        }
      });
      actions.appendChild(delBtn);
    }

    wrap.appendChild(bubble);
    wrap.appendChild(actions);
    box.appendChild(wrap);
  });
  box.scrollTop = box.scrollHeight;
}

function startReply(m, mine){
  const preview = m.type === 'text' ? m.text
    : m.type === 'image' ? '📷 Photo'
    : m.type === 'video' ? '🎥 Vidéo'
    : m.type === 'audio' ? '🎤 Message vocal' : '';
  replyingTo = { id: m.id, preview, senderName: mine ? currentProfile.name : activePeer.name };
  document.getElementById('reply-preview-name').textContent = replyingTo.senderName;
  document.getElementById('reply-preview-text').textContent = preview;
  document.getElementById('reply-preview-bar').style.display = 'flex';
  document.getElementById('chat-input').focus();
}
function cancelReply(){
  replyingTo = null;
  document.getElementById('reply-preview-bar').style.display = 'none';
}
document.getElementById('reply-cancel-btn').addEventListener('click', cancelReply);

function markConversationRead(){
  if(!activeConversationId) return;
  db.collection('conversations').doc(activeConversationId).update({
    ['lastRead.' + currentUser.uid]: firebase.firestore.FieldValue.serverTimestamp()
  }).catch(()=>{});
}

document.getElementById('chat-back-btn').addEventListener('click', () => {
  document.getElementById('chat-thread-screen').classList.remove('show');
  activeConversationId = null;
  if(unsubMessages) unsubMessages();
  if(unsubPeerPresence) unsubPeerPresence();
  if(unsubConvMeta) unsubConvMeta();
  clearTypingSoon();
});

/* ---------------------- MENU ⋮ : BLOQUER / SIGNALER ---------------------- */
document.getElementById('chat-menu-btn').addEventListener('click', () => {
  const menu = document.getElementById('chat-menu-dropdown');
  menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
});
document.getElementById('chat-block-option').addEventListener('click', async () => {
  if(!activePeer) return;
  await db.collection('users').doc(currentUser.uid).update({
    blockedUsers: firebase.firestore.FieldValue.arrayUnion(activePeer.uid)
  });
  currentProfile.blockedUsers = currentProfile.blockedUsers || [];
  if(!currentProfile.blockedUsers.includes(activePeer.uid)) currentProfile.blockedUsers.push(activePeer.uid);
  document.getElementById('chat-menu-dropdown').style.display = 'none';
  document.getElementById('chat-thread-screen').classList.remove('show');
  renderBlockedUsersList();
});
document.getElementById('chat-report-option').addEventListener('click', async () => {
  if(!activePeer) return;
  document.getElementById('chat-menu-dropdown').style.display = 'none';
  try{
    await db.collection('reports').add({
      reportedUid: activePeer.uid,
      reportedUsername: activePeer.username,
      byUid: currentUser.uid,
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    alert('Signalement envoyé. Merci.');
  } catch(err){
    alert("Le signalement n'a pas pu être envoyé (règle Firestore manquante côté configuration). Réessaie plus tard.");
  }
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

/* ---------------------- INDICATEUR « EN TRAIN D'ÉCRIRE » ---------------------- */
let typingTimeout = null;
function pingTyping(){
  if(!activeConversationId) return;
  db.collection('conversations').doc(activeConversationId).update({
    ['typing.' + currentUser.uid]: true
  }).catch(()=>{});
  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(clearTypingSoon, 2500);
}
function clearTypingSoon(){
  clearTimeout(typingTimeout);
  if(!activeConversationId) return;
  db.collection('conversations').doc(activeConversationId).update({
    ['typing.' + currentUser.uid]: false
  }).catch(()=>{});
}
document.getElementById('chat-input').addEventListener('input', pingTyping);

// --- Envoyer un message texte ---
document.getElementById('chat-send-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = document.getElementById('chat-input');
  const text = input.value.trim();
  if(!text || !activeConversationId) return;
  if(peerBlockedList.includes(currentUser.uid)){
    alert("Tu ne peux pas écrire à cette personne.");
    return;
  }
  input.value = '';
  clearTypingSoon();

  const convRef = await ensureConversationDoc();
  await convRef.update({
    lastMessage: text,
    lastMessageAt: firebase.firestore.FieldValue.serverTimestamp(),
    lastSenderId: currentUser.uid
  });
  const msgData = {
    senderId: currentUser.uid,
    type: 'text',
    text,
    createdAt: firebase.firestore.FieldValue.serverTimestamp()
  };
  if(replyingTo) msgData.replyTo = replyingTo;
  await convRef.collection('messages').add(msgData);
  cancelReply();
});

/* ---------------------- ENVOYER UNE PHOTO DANS LE CHAT ---------------------- */
document.getElementById('chat-photo-btn').addEventListener('click', () => {
  if(!activeConversationId) return;
  document.getElementById('chat-photo-input').click();
});

document.getElementById('chat-photo-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if(!file || !activeConversationId) return;
  const statusEl = document.getElementById('photo-send-status');
  statusEl.style.display = 'block';
  statusEl.textContent = 'Envoi de la photo…';
  try{
    const photo = await resizeImageKeepAspect(file, 800, 0.65);
    const convRef = await ensureConversationDoc();
    await convRef.update({
      lastMessage: '📷 Photo',
      lastMessageAt: firebase.firestore.FieldValue.serverTimestamp(),
      lastSenderId: currentUser.uid
    });
    await convRef.collection('messages').add({
      senderId: currentUser.uid,
      type: 'image',
      image: photo,
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });
  } catch(err){
    alert("Impossible d'envoyer cette photo : " + err.message);
  } finally {
    statusEl.style.display = 'none';
    e.target.value = '';
  }
});

/* ==========================================================================
   MESSAGES VOCAUX — vrai enregistrement micro, stocké en base64 dans
   Firestore (même principe que les photos), donc gratuit. Limité à 60
   secondes pour rester largement sous la limite de taille d'un document.
   L'interface remplace le champ de texte par une barre d'enregistrement
   en direct (point rouge + minuteur), comme WhatsApp.
   ========================================================================== */
let mediaRecorder = null;
let recordedChunks = [];
let recordingMaxTimer = null;
let recordingClockInterval = null;
let recordingSeconds = 0;

function updateRecordingClock(){
  const m = Math.floor(recordingSeconds / 60);
  const s = recordingSeconds % 60;
  document.getElementById('recording-timer').textContent = m + ':' + String(s).padStart(2, '0');
}

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
      clearTimeout(recordingMaxTimer);
      clearInterval(recordingClockInterval);
      recordingSeconds = 0;
      document.getElementById('recording-bar').style.display = 'none';
      document.getElementById('chat-input').style.display = 'block';
      document.getElementById('chat-photo-btn').style.display = 'flex';
      document.getElementById('chat-mic-btn').style.color = '';
      document.getElementById('chat-mic-btn').style.background = '';

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

    // Bascule visuelle : le champ de texte disparaît, la barre d'enregistrement apparaît
    document.getElementById('chat-input').style.display = 'none';
    document.getElementById('chat-photo-btn').style.display = 'none';
    document.getElementById('recording-bar').style.display = 'flex';
    document.getElementById('chat-mic-btn').style.color = '#fff';
    document.getElementById('chat-mic-btn').style.background = 'var(--magenta)';
    recordingSeconds = 0;
    updateRecordingClock();
    recordingClockInterval = setInterval(() => {
      recordingSeconds++;
      updateRecordingClock();
    }, 1000);

    // Coupure automatique à 60s pour rester sous la limite Firestore
    recordingMaxTimer = setTimeout(() => {
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

/* ---------------------- SONNERIE D'APPEL (universelle) ---------------------- */
let ringInterval = null;
let ringCtx = null;

function startRingtone(){
  stopRingtone();
  try{
    ringCtx = new (window.AudioContext || window.webkitAudioContext)();
    const ringOnce = () => {
      if(!ringCtx) return;
      [0, 0.4].forEach(delay => {
        const o = ringCtx.createOscillator();
        const g = ringCtx.createGain();
        o.type = 'sine';
        o.frequency.setValueAtTime(440, ringCtx.currentTime + delay);
        g.gain.setValueAtTime(0.001, ringCtx.currentTime + delay);
        g.gain.linearRampToValueAtTime(0.16, ringCtx.currentTime + delay + 0.05);
        g.gain.linearRampToValueAtTime(0.001, ringCtx.currentTime + delay + 0.35);
        o.connect(g); g.connect(ringCtx.destination);
        o.start(ringCtx.currentTime + delay);
        o.stop(ringCtx.currentTime + delay + 0.35);
      });
    };
    ringOnce();
    ringInterval = setInterval(ringOnce, 2000);
  } catch(e){ /* audio non disponible */ }
}

function stopRingtone(){
  if(ringInterval){ clearInterval(ringInterval); ringInterval = null; }
  if(ringCtx){ ringCtx.close().catch(()=>{}); ringCtx = null; }
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
          startRingtone();
          const accept = confirm(`Appel ${callType === 'audio' ? 'audio' : 'vidéo'} entrant de ${conv.memberNames[peerUid]}. Répondre ?`);
          stopRingtone();
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
    startRingtone(); // ça sonne chez l'appelant tant que l'autre n'a pas décroché

    callDoc.onSnapshot(async (snap) => {
      const data = snap.data();
      if(data && data.answer && peerConnection.currentRemoteDescription === null){
        stopRingtone();
        document.getElementById('call-status-label').textContent = callType === 'audio' ? 'Appel audio connecté' : 'Appel vidéo connecté';
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
/* ---------------------- VISIONNEUSE PLEIN ÉCRAN + TÉLÉCHARGEMENT ---------------------- */
function openLightbox(src, type, filename){
  const img = document.getElementById('lightbox-img');
  const vid = document.getElementById('lightbox-video');
  const dl = document.getElementById('lightbox-download');
  if(type === 'video'){
    img.style.display = 'none'; img.src = '';
    vid.style.display = 'block'; vid.src = src;
    dl.download = (filename || 'kongovibe-video') + '.webm';
  } else {
    vid.pause(); vid.style.display = 'none'; vid.src = '';
    img.style.display = 'block'; img.src = src;
    dl.download = (filename || 'kongovibe-photo') + '.jpg';
  }
  dl.href = src;
  document.getElementById('lightbox-screen').classList.add('show');
}
document.getElementById('lightbox-close').addEventListener('click', () => {
  document.getElementById('lightbox-screen').classList.remove('show');
  document.getElementById('lightbox-video').pause();
});

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
let postMode = 'photo'; // 'photo' ou 'video'
let videoRecordStream = null;
let postVideoRecorder = null;
let postVideoChunks = [];
let recordedVideoBlob = null;

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

// --- Bascule Photo / Vidéo courte ---
document.getElementById('mode-photo-btn').addEventListener('click', () => {
  postMode = 'photo';
  document.getElementById('mode-photo-btn').className = 'btn primary glossy';
  document.getElementById('mode-video-btn').className = 'btn ghost';
  document.getElementById('photo-mode-block').style.display = 'block';
  document.getElementById('video-mode-block').style.display = 'none';
});
document.getElementById('mode-video-btn').addEventListener('click', () => {
  postMode = 'video';
  document.getElementById('mode-video-btn').className = 'btn primary glossy';
  document.getElementById('mode-photo-btn').className = 'btn ghost';
  document.getElementById('photo-mode-block').style.display = 'none';
  document.getElementById('video-mode-block').style.display = 'block';
});

// --- Enregistrement vidéo courte (8s max, direct uniquement) ---
document.getElementById('video-record-btn').addEventListener('click', async () => {
  const btn = document.getElementById('video-record-btn');
  const preview = document.getElementById('video-record-preview');

  if(postVideoRecorder && postVideoRecorder.state === 'recording'){
    postVideoRecorder.stop();
    return;
  }

  try{
    videoRecordStream = await navigator.mediaDevices.getUserMedia({
      video: { width: 480, height: 480 }, audio: true
    });
    preview.srcObject = videoRecordStream;
    preview.style.display = 'block';
    preview.muted = true;
    preview.play();

    postVideoChunks = [];
    postVideoRecorder = new MediaRecorder(videoRecordStream, { videoBitsPerSecond: 250000 });
    postVideoRecorder.ondataavailable = (e) => { if(e.data.size > 0) postVideoChunks.push(e.data); };
    postVideoRecorder.onstop = () => {
      videoRecordStream.getTracks().forEach(t => t.stop());
      recordedVideoBlob = new Blob(postVideoChunks, { type: 'video/webm' });
      preview.srcObject = null;
      preview.src = URL.createObjectURL(recordedVideoBlob);
      preview.muted = false;
      preview.controls = true;
      btn.textContent = '🎥 Recommencer';

      const dlBtn = document.getElementById('video-download-btn');
      dlBtn.href = preview.src;
      dlBtn.download = 'kongovibe-video-' + Date.now() + '.webm';
      dlBtn.style.display = 'block';
    };
    postVideoRecorder.start();
    btn.textContent = '⏹ Arrêter (8s max)';

    setTimeout(() => {
      if(postVideoRecorder && postVideoRecorder.state === 'recording') postVideoRecorder.stop();
    }, 8000);
  } catch(err){
    alert("Impossible d'accéder à la caméra : " + err.message);
  }
});

// --- Ouverture / fermeture de l'écran de publication ---
document.getElementById('open-create-post').addEventListener('click', () => {
  document.getElementById('create-post-screen').classList.add('show');
});
document.getElementById('create-post-back').addEventListener('click', () => {
  document.getElementById('create-post-screen').classList.remove('show');
  if(postVideoRecorder && postVideoRecorder.state === 'recording') postVideoRecorder.stop();
});

document.getElementById('post-publish-btn').addEventListener('click', async () => {
  const statusEl = document.getElementById('post-status');
  const caption = document.getElementById('post-caption').value.trim();
  if(!currentUser){ alert('Connecte-toi pour publier.'); return; }

  if(postMode === 'photo'){
    if(!selectedPostFile){ alert('Choisis une photo à publier.'); return; }
    statusEl.style.display = 'block';
    statusEl.textContent = 'Préparation de la photo…';
    try{
      const photo = await compressPostImage(selectedPostFile);
      statusEl.textContent = 'Publication…';
      await db.collection('posts').add({
        uid: currentUser.uid, name: currentProfile.name, username: currentProfile.username,
        authorPhoto: currentProfile.photo || '', type: 'photo',
        photo, caption, likes: 0, likedBy: [], commentsCount: 0,
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      });
      resetPostForm();
    } catch(err){
      statusEl.textContent = 'Erreur : ' + err.message;
    }
  } else {
    if(!recordedVideoBlob){ alert('Enregistre une courte vidéo avant de publier.'); return; }
    statusEl.style.display = 'block';
    statusEl.textContent = 'Préparation de la vidéo…';
    try{
      const videoBase64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(recordedVideoBlob);
      });
      if(videoBase64.length > 900000){
        statusEl.textContent = 'Cette vidéo est trop lourde pour être publiée gratuitement. Réessaie avec un clip plus court ou moins de mouvement.';
        return;
      }
      statusEl.textContent = 'Publication…';
      await db.collection('posts').add({
        uid: currentUser.uid, name: currentProfile.name, username: currentProfile.username,
        authorPhoto: currentProfile.photo || '', type: 'video',
        video: videoBase64, caption, likes: 0, likedBy: [], commentsCount: 0,
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      });
      resetPostForm();
    } catch(err){
      statusEl.textContent = 'Erreur : ' + err.message;
    }
  }
});

function resetPostForm(){
  selectedPostFile = null;
  recordedVideoBlob = null;
  document.getElementById('post-file-input').value = '';
  document.getElementById('post-caption').value = '';
  document.getElementById('post-preview').style.display = 'none';
  document.getElementById('post-picker').textContent = '📷 Choisir une photo à publier';
  const videoPreview = document.getElementById('video-record-preview');
  videoPreview.style.display = 'none';
  videoPreview.removeAttribute('src');
  document.getElementById('video-record-btn').textContent = "🎥 Démarrer l'enregistrement";
  document.getElementById('video-download-btn').style.display = 'none';
  document.getElementById('post-status').style.display = 'none';
  document.getElementById('create-post-screen').classList.remove('show');
  document.getElementById('mode-photo-btn').click();
}

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
          ${post.type === 'video' && post.video
            ? `<video class="post-photo" src="${post.video}" controls playsinline></video>`
            : `<img class="post-photo" src="${post.photo}" alt="" style="cursor:pointer;">`}
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
        if(post.type !== 'video'){
          card.querySelector('.post-photo').addEventListener('click', () => openLightbox(post.photo, 'photo', 'kongovibe-' + postId));
        }
        feed.appendChild(card);
      });
    }, err => {
      console.error('Fil:', err);
      feed.innerHTML = '<div class="meta" style="padding:14px 4px; color:var(--magenta);">Erreur de chargement du fil : ' + escapeHtml(err.message) + '</div>';
    });
}

/* ==========================================================================
   PROFIL FAÇON TIKTOK — mes publications, mes stats réelles (likes,
   commentaires), et une vraie notification quand quelqu'un aime une
   publication. Tout est calculé à partir des vraies données Firestore.
   ========================================================================== */
let unsubMyPosts = null;
let knownLikeCounts = {}; // pour détecter une VRAIE augmentation de likes

function startMyPostsListener(){
  if(!currentUser) return;
  unsubMyPosts = db.collection('posts').where('uid', '==', currentUser.uid)
    .onSnapshot(snap => {
      let totalLikes = 0, totalComments = 0;
      const grid = document.getElementById('my-posts-grid');
      grid.innerHTML = '';

      const docs = snap.docs.slice().sort((a, b) => {
        const ta = a.data().createdAt ? a.data().createdAt.toMillis() : 0;
        const tb = b.data().createdAt ? b.data().createdAt.toMillis() : 0;
        return tb - ta;
      });

      docs.forEach(doc => {
        const post = doc.data();
        totalLikes += post.likes || 0;
        totalComments += post.commentsCount || 0;

        const cell = document.createElement('div');
        cell.className = 'cell';
        const thumbSrc = post.type === 'video' ? '' : post.photo;
        cell.innerHTML = `
          ${post.type === 'video'
            ? `<video src="${post.video}" muted></video>`
            : `<img src="${thumbSrc}" alt="">`}
          <div class="cell-likes">♥ ${post.likes || 0}</div>`;
        cell.addEventListener('click', () => openLightbox(post.type === 'video' ? post.video : post.photo, post.type === 'video' ? 'video' : 'photo', 'kongovibe-' + doc.id));
        grid.appendChild(cell);

        // --- Notification réelle : quelqu'un a aimé ma publication ---
        const prevLikes = knownLikeCounts[doc.id];
        if(prevLikes !== undefined && (post.likes || 0) > prevLikes){
          notifyNewMessage('Nouveau like ✦', 'Quelqu\'un a aimé ta publication');
        }
        knownLikeCounts[doc.id] = post.likes || 0;
      });

      document.getElementById('stat-posts').textContent = docs.length;
      document.getElementById('stat-likes').textContent = totalLikes;
      document.getElementById('stat-comments').textContent = totalComments;

      if(docs.length === 0){
        grid.innerHTML = '<div class="meta" style="padding:10px 4px; grid-column: span 3;">Tu n\'as encore rien publié.</div>';
      }
    }, err => console.error('Mes publications:', err));
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
