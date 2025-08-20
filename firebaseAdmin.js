const admin = require('firebase-admin');

let serviceAccount;

// ✅ Load service account from environment variable instead of file
if (process.env.FIREBASE_KEY_JSON) {
  serviceAccount = JSON.parse(process.env.FIREBASE_KEY_JSON);
} else {
  throw new Error("Missing FIREBASE_KEY_JSON environment variable");
}

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

const db = admin.firestore();

module.exports = { admin, db };
