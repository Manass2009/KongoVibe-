// Fonction pour basculer de l'écran de connexion vers l'app principale
function goToApp() {
    document.getElementById('screen-login').classList.add('hidden');
    document.getElementById('main-app').classList.remove('hidden');
    document.getElementById('bottom-nav').classList.remove('hidden');
}

// Fonction de navigation entre les onglets
function switchTab(tabName) {
    // Gère l'affichage selon le bouton cliqué
    if (tabName === 'messages') {
        // Tu pourras ajouter la logique d'affichage des messages ici
        alert("Onglet Messages actif");
    } else if (tabName === 'reels') {
        alert("Onglet Reels actif");
    }
}

