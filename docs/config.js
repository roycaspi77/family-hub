// Public settings, shared by the page and the push service worker (so: self, not window).

// The Apps Script web app URL (Deploy > Manage deployments > Web app URL, ends in /exec).
self.FAMILY_HUB_API = 'https://script.google.com/macros/s/AKfycbzwsQnfAGI6wX8j_WnY6tetWLFCnmi4HNUx6FXwOEc93kXWt8YaWT0i2X3GDsbiQsK2/exec';

// Firebase > Project settings > General > Your apps > Web app > SDK setup (Config).
// These values are public by design; the secret key stays in Apps Script.
self.FAMILY_HUB_FIREBASE = {
  apiKey: 'AIzaSyAGq6AzVcjLWoqF1jPNpLi8YGQWoBj84ak',
  authDomain: 'family-hub-a93cf.firebaseapp.com',
  projectId: 'family-hub-a93cf',
  storageBucket: 'family-hub-a93cf.firebasestorage.app',
  messagingSenderId: '245571841333',
  appId: '1:245571841333:web:b1e4feddeeb21d946df07c',
};

// Firebase > Project settings > Cloud Messaging > Web Push certificates > Key pair.
self.FAMILY_HUB_VAPID_KEY = 'BDHFXIyQTTHXRFnRuc6AidODqg63nR0G34LiA1pEUZmQlJQTIAxnc8TlH5ahJxhBWC6K0y4DitkC61WERF7HLVQ';
