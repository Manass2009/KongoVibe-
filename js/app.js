document.addEventListener('DOMContentLoaded', () => {
    
    const navButtons = document.querySelectorAll('.nav-btn');
    const tabs = document.querySelectorAll('.tab-content');
    const appContainer = document.getElementById('app-container');

    // Gère le changement d'onglet
    navButtons.forEach(button => {
        button.addEventListener('click', (event) => {
            
            // 1. Désactiver tous les boutons de la nav
            navButtons.forEach(btn => btn.classList.remove('active'));
            
            // 2. Activer le bouton cliqué
            button.classList.add('active');
            
            // 3. Cacher tous les onglets
            tabs.forEach(tab => tab.classList.remove('active'));
            
            // 4. Activer l'onglet correspondant au 'data-tab' du bouton
            const targetTabId = button.getAttribute('data-tab');
            document.getElementById('tab-' + targetTabId).classList.add('active');
            
            // 5. Remonter en haut de la page lors du changement (sauf pour les Shorts)
            if (targetTabId !== 'shorts') {
                appContainer.scrollTo(0, 0);
            }
        });
    });

});

