const admin = require('firebase-admin');
const serviceAccount = require('./lb-league-24d6e-firebase-adminsdk-fbsvc-5bf19c4398.json');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

const db = admin.firestore();

module.exports = { admin, db };
