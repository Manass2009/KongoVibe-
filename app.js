/* ============================================================
   KONGOVIBE — app.js
   Version stable : Firebase Auth + Firestore
   Compatible avec le HTML fourni
   ============================================================ */

'use strict';

let currentUser = null;
let currentProfile = null;

let unsubConversations = null;
let unsubMessages = null;

let activeConversationId = null;
let activePeer = null;

/* ============================================================
   OUTILS
   ============================================================ */

function $(id) {
  return document.getElementById(id);
}

function showError(message) {
  console.error('[KongoVibe]', message);
  alert(message);
}

function escapeHtml(value) {
  const div = document.createElement('div');
  div.textContent = value ?? '';
  return div.innerHTML;
}

function normalizeUsername(username) {
  return String(username || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.]/g, '_');
}

function formatTime(timestamp) {
  if (!timestamp || !timestamp.toDate) return '';

  const date = timestamp.toDate();

  return date.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit'
  });
}

function readableAuthError(error) {
  const errors = {
    'auth/email-already-in-use':
      'Cette adresse e-mail est déjà utilisée.',

    'auth/invalid-email':
      'Cette adresse e-mail est invalide.',

    'auth/weak-password':
      'Le mot de passe est trop faible.',

    'auth/user-not-found':
      'Aucun compte ne correspond à ces informations.',

    'auth/wrong-password':
      'Mot de passe incorrect.',

    'auth/invalid-credential':
      'Adresse e-mail ou mot de passe incorrect.',

    'auth/network-request-failed':
      'Impossible de contacter Firebase. Vérifie ta connexion Internet.',

    'permission-denied':
      'Firebase refuse cette opération. Vérifie les règles Firestore.',

    'failed-precondition':
      'Firebase demande probablement un index Firestore.',
  };

  return errors[error?.code] ||
    error?.message ||
    'Une erreur inconnue est survenue.';
}


/* ============================================================
   VÉRIFICATION FIREBASE
   ============================================================ */

if (typeof firebase === 'undefined') {
  showError(
    'Firebase SDK n’a pas été chargé. Vérifie les scripts Firebase dans index.html.'
  );
  throw new Error('Firebase SDK absent');
}

if (typeof auth === 'undefined' || typeof db === 'undefined') {
  showError(
    'Firebase n’est pas correctement initialisé. Vérifie firebase-config.js.'
  );
  throw new Error('Firebase non initialisé');
}

console.log('🔥 KongoVibe : Firebase chargé');


/* ============================================================
   NAVIGATION
   ============================================================ */

const navItems = document.querySelectorAll('.nav-item');
const views = document.querySelectorAll('.view');

navItems.forEach(item => {

  item.addEventListener('click', () => {

    const target = item.dataset.view;

    if (!target) return;

    const targetView = $('view-' + target);

    if (!targetView) {
      console.warn(
        'Vue inexistante : view-' + target
      );
      return;
    }

    navItems.forEach(nav =>
      nav.classList.remove('active')
    );

    item.classList.add('active');

    views.forEach(view =>
      view.classList.remove('active')
    );

    targetView.classList.add('active');

    const container = document.querySelector('.views');

    if (container) {
      container.scrollTop = 0;
    }
  });

});


/* ============================================================
   SERVICE WORKER
   ============================================================ */

if ('serviceWorker' in navigator) {

  window.addEventListener('load', () => {

    navigator.serviceWorker
      .register('./sw.js')
      .then(() => {
        console.log('Service Worker enregistré');
      })
      .catch(error => {
        console.warn(
          'Service Worker non disponible :',
          error
        );
      });

  });

}


/* ============================================================
   ÉCRAN AUTHENTIFICATION
   ============================================================ */

const registerForm = $('register-form');
const loginForm = $('login-form');

const authTitle = $('auth-title');
const authSubtitle = $('auth-subtitle');

const switchToLogin = $('switch-to-login');
const switchToRegister = $('switch-to-register');

const usernameError = $('username-error');
const loginError = $('login-error');


/* ---------- Passer à connexion ---------- */

if (switchToLogin) {

  switchToLogin.addEventListener('click', () => {

    registerForm?.classList.add('auth-hidden');
    loginForm?.classList.remove('auth-hidden');

    switchToLogin.classList.add('auth-hidden');
    switchToRegister?.classList.remove('auth-hidden');

    if (authTitle)
      authTitle.textContent = 'Content de te revoir';

    if (authSubtitle)
      authSubtitle.textContent =
        'Connecte-toi pour retrouver tes messages et ton compte.';

  });

}


/* ---------- Passer à inscription ---------- */

if (switchToRegister) {

  switchToRegister.addEventListener('click', () => {

    loginForm?.classList.add('auth-hidden');
    registerForm?.classList.remove('auth-hidden');

    switchToRegister.classList.add('auth-hidden');
    switchToLogin?.classList.remove('auth-hidden');

    if (authTitle)
      authTitle.textContent = 'Créer ton compte';

    if (authSubtitle)
      authSubtitle.textContent =
        'Rejoins KongoVibe pour parler, appeler, créer et suivre tes communautés.';

  });

}


/* ============================================================
   INSCRIPTION
   ============================================================ */

if (registerForm) {

  registerForm.addEventListener('submit', async event => {

    event.preventDefault();

    const button =
      registerForm.querySelector('.auth-submit');

    const name =
      $('reg-name')?.value.trim();

    const username =
      normalizeUsername($('reg-username')?.value);

    const email =
      $('reg-contact')?.value.trim();

    const password =
      $('reg-password')?.value;

    if (usernameError)
      usernameError.style.display = 'none';

    if (!name || !username || !email || !password) {
      showError('Remplis tous les champs.');
      return;
    }

    if (password.length < 6) {
      showError(
        'Le mot de passe doit contenir au moins 6 caractères.'
      );
      return;
    }

    if (button) {
      button.disabled = true;
      button.textContent = 'Création…';
    }

    try {

      /*
       * Vérification du nom d'utilisateur
       */

      const usernameRef =
        db.collection('usernames').doc(username);

      const usernameSnapshot =
        await usernameRef.get();

      if (usernameSnapshot.exists) {

        if (usernameError) {
          usernameError.textContent =
            'Ce nom d’utilisateur est déjà utilisé.';

          usernameError.style.display = 'block';
        }

        return;
      }


      /*
       * Création Firebase Authentication
       */

      const credential =
        await auth.createUserWithEmailAndPassword(
          email,
          password
        );

      const user = credential.user;


      /*
       * Création du profil
       */

      const profile = {
        uid: user.uid,
        name: name,
        username: username,
        email: email,
        bio: '',
        createdAt:
          firebase.firestore.FieldValue.serverTimestamp()
      };


      await db
        .collection('users')
        .doc(user.uid)
        .set(profile);


      /*
       * Réservation du username
       */

      await usernameRef.set({
        uid: user.uid
      });


      console.log(
        'Compte créé :',
        user.uid
      );


      registerForm.reset();

    } catch (error) {

      console.error(
        'Erreur inscription :',
        error
      );

      showError(
        readableAuthError(error)
      );

    } finally {

      if (button) {
        button.disabled = false;
        button.textContent = 'Créer mon compte';
      }

    }

  });

}


/* ============================================================
   CONNEXION
   ============================================================ */

if (loginForm) {

  loginForm.addEventListener('submit', async event => {

    event.preventDefault();

    const button =
      loginForm.querySelector('.auth-submit');

    const identifier =
      $('log-username')?.value.trim();

    const password =
      $('log-password')?.value;

    if (loginError)
      loginError.style.display = 'none';

    if (!identifier || !password) {

      if (loginError) {
        loginError.textContent =
          'Entre ton identifiant et ton mot de passe.';

        loginError.style.display = 'block';
      }

      return;
    }

    if (button) {
      button.disabled = true;
      button.textContent = 'Connexion…';
    }

    try {

      let email = identifier;


      /*
       * Connexion avec username
       */

      if (!identifier.includes('@')) {

        const username =
          normalizeUsername(identifier);

        const usernameDoc =
          await db
            .collection('usernames')
            .doc(username)
            .get();

        if (!usernameDoc.exists) {
          throw {
            code: 'auth/user-not-found'
          };
        }

        const uid =
          usernameDoc.data().uid;

        const profileDoc =
          await db
            .collection('users')
            .doc(uid)
            .get();

        if (!profileDoc.exists) {
          throw {
            code: 'auth/user-not-found'
          };
        }

        email =
          profileDoc.data().email;
      }


      /*
       * Connexion Firebase
       */

      await auth.signInWithEmailAndPassword(
        email,
        password
      );

    } catch (error) {

      console.error(
        'Erreur connexion :',
        error
      );

      if (loginError) {

        loginError.textContent =
          readableAuthError(error);

        loginError.style.display =
          'block';

      } else {

        showError(
          readableAuthError(error)
        );

      }

    } finally {

      if (button) {
        button.disabled = false;
        button.textContent = 'Se connecter';
      }

    }

  });

}


/* ============================================================
   DÉCONNEXION
   ============================================================ */

const logoutButton = $('logout-btn');

if (logoutButton) {

  logoutButton.addEventListener('click', async () => {

    try {

      await auth.signOut();

    } catch (error) {

      showError(
        readableAuthError(error)
      );

    }

  });

}


/* ============================================================
   AUTH STATE
   ============================================================ */

auth.onAuthStateChanged(async user => {

  console.log(
    'État Firebase :',
    user ? 'CONNECTÉ' : 'DÉCONNECTÉ'
  );


  /* Splash */

  $('splash-screen')
    ?.classList.add('hide');


  /* ---------------- CONNECTÉ ---------------- */

  if (user) {

    currentUser = user;

    try {

      const profileDoc =
        await db
          .collection('users')
          .doc(user.uid)
          .get();

      if (profileDoc.exists) {

        currentProfile =
          profileDoc.data();

      } else {

        currentProfile = {

          uid: user.uid,

          name:
            user.displayName ||
            user.email ||
            'Utilisateur',

          username:
            user.email?.split('@')[0] ||
            'utilisateur',

          email:
            user.email || '',

          bio: ''

        };

      }


      applyProfile(
        currentProfile
      );


      $('auth-screen')
        ?.classList.remove('show');


      startConversationsListener();


    } catch (error) {

      console.error(
        'Erreur chargement profil :',
        error
      );

      showError(
        readableAuthError(error)
      );

    }


  /* ---------------- DÉCONNECTÉ ---------------- */

  } else {

    currentUser = null;
    currentProfile = null;

    if (unsubConversations) {
      unsubConversations();
      unsubConversations = null;
    }

    if (unsubMessages) {
      unsubMessages();
      unsubMessages = null;
    }

    $('auth-screen')
      ?.classList.add('show');

  }

});


/* ============================================================
   PROFIL
   ============================================================ */

function applyProfile(profile) {

  const nameElement =
    $('profile-name');

  const handleElement =
    $('profile-handle');

  if (nameElement) {

    nameElement.textContent =
      profile.name ||
      'Utilisateur';

  }

  if (handleElement) {

    handleElement.textContent =
      '@' +
      (
        profile.username ||
        'utilisateur'
      );

  }

}


/* ============================================================
   CONVERSATION ID
   ============================================================ */

function conversationId(uidA, uidB) {

  return [uidA, uidB]
    .sort()
    .join('_');

}


/* ============================================================
   RECHERCHE UTILISATEUR
   ============================================================ */

const searchButton =
  $('dm-search-btn');

if (searchButton) {

  searchButton.addEventListener(
    'click',
    async () => {

      if (!currentUser) {
        showError(
          'Connecte-toi d’abord.'
        );
        return;
      }

      const input =
        $('dm-search-input');

      const results =
        $('dm-search-results');

      const username =
        normalizeUsername(
          input?.value
        );

      if (results)
        results.innerHTML = '';

      if (!username)
        return;

      try {

        const usernameDoc =
          await db
            .collection('usernames')
            .doc(username)
            .get();

        if (!usernameDoc.exists) {

          if (results) {

            results.innerHTML =
              '<div class="meta" style="padding:10px 4px;">' +
              'Utilisateur introuvable.' +
              '</div>';

          }

          return;
        }


        const uid =
          usernameDoc.data().uid;


        if (uid === currentUser.uid) {

          if (results) {

            results.innerHTML =
              '<div class="meta" style="padding:10px 4px;">' +
              'C’est ton propre compte 🙂' +
              '</div>';

          }

          return;
        }


        const userDoc =
          await db
            .collection('users')
            .doc(uid)
            .get();


        if (!userDoc.exists) {

          showError(
            'Le profil de cet utilisateur est introuvable.'
          );

          return;
        }


        const peer =
          userDoc.data();


        const row =
          document.createElement('div');

        row.className = 'conv';

        row.innerHTML = `
          <div class="avatar">👤</div>

          <div class="conv-info">

            <div class="conv-top">
              <span class="who">
                ${escapeHtml(peer.name)}
              </span>
            </div>

            <div class="conv-sub">
              <p>
                @${escapeHtml(peer.username)}
              </p>
            </div>

          </div>
        `;


        row.addEventListener(
          'click',
          () => {

            openChatThread({
              uid: peer.uid,
              name: peer.name,
              username: peer.username
            });

            if (results)
              results.innerHTML = '';

            if (input)
              input.value = '';

          }
        );


        results?.appendChild(row);

      } catch (error) {

        console.error(
          'Erreur recherche :',
          error
        );

        showError(
          readableAuthError(error)
        );

      }

    }
  );

}


/* ============================================================
   LISTE DES CONVERSATIONS
   ============================================================ */

function startConversationsListener() {

  if (!currentUser)
    return;


  const list =
    $('conversations-list');

  if (!list)
    return;


  if (unsubConversations) {
    unsubConversations();
    unsubConversations = null;
  }


  /*
   * Pour éviter les problèmes d'index Firestore,
   * on commence sans orderBy.
   */

  unsubConversations =
    db
      .collection('conversations')
      .where(
        'members',
        'array-contains',
        currentUser.uid
      )
      .onSnapshot(

        snapshot => {

          if (snapshot.empty) {

            list.innerHTML =
              '<div class="meta" style="padding:14px 4px;">' +
              'Aucune conversation pour l’instant.' +
              '</div>';

            return;
          }


          const conversations = [];

          snapshot.forEach(doc => {

            conversations.push({
              id: doc.id,
              ...doc.data()
            });

          });


          /*
           * Tri côté navigateur.
           */

          conversations.sort(
            (a, b) => {

              const ta =
                a.lastMessageAt?.toMillis?.() || 0;

              const tb =
                b.lastMessageAt?.toMillis?.() || 0;

              return tb - ta;

            }
          );


          list.innerHTML = '';


          conversations.forEach(
            conversation => {

              const peerUid =
                conversation.members.find(
                  uid =>
                    uid !== currentUser.uid
                );


              if (!peerUid)
                return;


              const peerName =
                conversation.memberNames?.[peerUid] ||
                'Utilisateur';


              const peerUsername =
                conversation.memberUsernames?.[peerUid] ||
                '';


              const row =
                document.createElement('div');

              row.className = 'conv';


              row.innerHTML = `

                <div class="avatar">
                  👤
                  <div class="dot-online"></div>
                </div>

                <div class="conv-info">

                  <div class="conv-top">

                    <span class="who">
                      ${escapeHtml(peerName)}
                    </span>

                    <span class="time">
                      ${formatTime(
                        conversation.lastMessageAt
                      )}
                    </span>

                  </div>

                  <div class="conv-sub">

                    <p>
                      ${escapeHtml(
                        conversation.lastMessage || ''
                      )}
                    </p>

                  </div>

                </div>
              `;


              row.addEventListener(
                'click',
                () => {

                  openChatThread({

                    uid: peerUid,

                    name: peerName,

                    username:
                      peerUsername

                  });

                }
              );


              list.appendChild(row);

            }
          );

        },

        error => {

          console.error(
            'Erreur conversations :',
            error
          );

          list.innerHTML =
            '<div class="meta" style="padding:14px 4px;">' +
            'Impossible de charger les conversations.' +
            '</div>';

        }

      );

}


/* ============================================================
   OUVRIR UNE CONVERSATION
   ============================================================ */

function openChatThread(peer) {

  if (!currentUser)
    return;

  activePeer = peer;

  activeConversationId =
    conversationId(
      currentUser.uid,
      peer.uid
    );


  $('chat-peer-name').textContent =
    peer.name || 'Utilisateur';

  $('chat-peer-handle').textContent =
    '@' +
    (peer.username || 'utilisateur');


  $('chat-thread-screen')
    ?.classList.add('show');


  const messagesBox =
    $('chat-messages');


  if (!messagesBox)
    return;


  messagesBox.innerHTML = '';


  if (unsubMessages) {
    unsubMessages();
    unsubMessages = null;
  }


  unsubMessages =
    db
      .collection('conversations')
      .doc(activeConversationId)
      .collection('messages')
      .orderBy('createdAt', 'asc')
      .onSnapshot(

        snapshot => {

          messagesBox.innerHTML = '';


          snapshot.forEach(
            doc => {

              const message =
                doc.data();

              const bubble =
                document.createElement('div');


              const mine =
                message.senderId ===
                currentUser.uid;


              bubble.style.cssText = `

                max-width:75%;

                margin:6px 0;

                padding:10px 13px;

                border-radius:16px;

                font-size:13.5px;

                line-height:1.4;

                word-break:break-word;

                ${
                  mine
                    ? 'margin-left:auto;background:var(--grad-aura);color:#0A0A12;'
                    : 'background:var(--bg-panel);border:1px solid var(--line);'
                }

              `;


              bubble.textContent =
                message.text || '';


              messagesBox.appendChild(
                bubble
              );

            }
          );


          messagesBox.scrollTop =
            messagesBox.scrollHeight;

        },

        error => {

          console.error(
            'Erreur messages :',
            error
          );

          messagesBox.innerHTML =
            '<div class="meta">' +
            'Impossible de charger les messages.' +
            '</div>';

        }

      );

}


/* ============================================================
   FERMER CHAT
   ============================================================ */

const chatBack =
  $('chat-back-btn');

if (chatBack) {

  chatBack.addEventListener(
    'click',
    () => {

      $('chat-thread-screen')
        ?.classList.remove('show');


      if (unsubMessages) {

        unsubMessages();

        unsubMessages = null;

      }

      activeConversationId = null;
      activePeer = null;

    }
  );

}


/* ============================================================
   ENVOYER MESSAGE
   ============================================================ */

const chatForm =
  $('chat-send-form');

if (chatForm) {

  chatForm.addEventListener(
    'submit',
    async event => {

      event.preventDefault();


      if (!currentUser ||
          !activePeer ||
          !activeConversationId) {

        showError(
          'Aucune conversation sélectionnée.'
        );

        return;
      }


      const input =
        $('chat-input');

      const text =
        input?.value.trim();


      if (!text)
        return;


      input.value = '';


      try {

        const conversationRef =
          db
            .collection('conversations')
            .doc(activeConversationId);


        const conversationSnapshot =
          await conversationRef.get();


        if (!conversationSnapshot.exists) {

          await conversationRef.set({

            members: [
              currentUser.uid,
              activePeer.uid
            ],

            memberNames: {

              [currentUser.uid]:
                currentProfile?.name ||
                currentUser.email,

              [activePeer.uid]:
                activePeer.name

            },

            memberUsernames: {

              [currentUser.uid]:
                currentProfile?.username ||
                '',

              [activePeer.uid]:
                activePeer.username ||
                ''

            },

            lastMessage:
              text,

            lastMessageAt:
              firebase.firestore
                .FieldValue
                .serverTimestamp()

          });

        } else {

          await conversationRef.update({

            lastMessage:
              text,

            lastMessageAt:
              firebase.firestore
                .FieldValue
                .serverTimestamp()

          });

        }


        await conversationRef
          .collection('messages')
          .add({

            senderId:
              currentUser.uid,

            text:
              text,

            createdAt:
              firebase.firestore
                .FieldValue
                .serverTimestamp()

          });


      } catch (error) {

        console.error(
          'Erreur envoi message :',
          error
        );

        showError(
          readableAuthError(error)
        );

      }

    }
  );

}


/* ============================================================
   TOUCHES ENTER / CONFORT
   ============================================================ */

const usernameInput =
  $('dm-search-input');

if (usernameInput) {

  usernameInput.addEventListener(
    'keydown',
    event => {

      if (event.key === 'Enter') {

        event.preventDefault();

        $('dm-search-btn')?.click();

      }

    }
  );

}


/* ============================================================
   DÉMARRAGE
   ============================================================ */

console.log(
  '🚀 KongoVibe démarré correctement.'
);
