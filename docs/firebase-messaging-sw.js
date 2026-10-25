// Service worker for push notifications. Firebase shows each notification
// (title, text, icon) and opens the app when it is tapped.
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');
importScripts('config.js');

if (self.FAMILY_HUB_FIREBASE && self.FAMILY_HUB_FIREBASE.apiKey) {
  firebase.initializeApp(self.FAMILY_HUB_FIREBASE);
  firebase.messaging();
}
