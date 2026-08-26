const CACHE_NAME = 'kongovibe-v1';
const ASSETS_TO_CACHE = [logo.png]
  './',
  './index.html',
  './css/style.css',
  './js/app.js',
  './manifest.json',
  'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap'
];

// 1. Phase d'installation (Mise en cache des ressources de base)
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('Mise en cache des ressources');
        return cache.addAll(ASSETS_TO_CACHE);
      })
  );
});

// 2. Phase d'activation (Nettoyage des anciens caches)
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cache => {
          if (cache !== CACHE_NAME) {
            console.log('Suppression de l\'ancien cache', cache);
            return caches.delete(cache);
          }
        })
      );
    })
  );
});

// 3. Phase de fetch (Stratégie de Cache: Cache first, Network fallback)
self.addEventListener('fetch', event => {
  event.respondWith(
    caches.match(event.request)
      .then(response => {
        // Retourne la ressource si elle est dans le cache
        return response || fetch(event.request);
      })
  );
});

