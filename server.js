const express = require('express');
const path = require('path');
const cors = require('cors');

=======
const cron = require('node-cron');

const app = express(); // ✅ Initialize Express

let serviceAccount;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} else {
  serviceAccount = require('./config/firebase-service-account.json');
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore(); // ✅ Firestore setup
const updateLeagueSnapshot = require('./utils/updateLeagueSnapshot'); // ✅ Only once

// const FREEZE_TIME = new Date('2025-07-26T01:00:00-07:00').getTime();

// if (Date.now() >= FREEZE_TIME) {
//   console.log('📌 League frozen. Skipping snapshot generation.');
//   process.exit(0);
// }



// Serve recent matches
app.get('/api/matches', async (req, res) => {
  try {
    const snapshot = await db.collection('matches')
      .orderBy('timestamp', 'desc')
      .limit(100)
      .get();

    const matches = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.status(200).json(matches);
  } catch (error) {
    console.error('❌ Failed to fetch matches:', error);
    res.status(500).json({ error: 'Failed to fetch matches' });
  }
});


app.post('/api/delete-3638105-before-3am', async (req, res) => {
  try {
    await deleteMatchesForClubBeforeDate('3638105', '2025-07-23T10:00:00Z');
    res.status(200).send({ message: 'Matches deleted.' });
  } catch (err) {
    console.error(err);
    res.status(500).send({ error: 'Failed to delete matches.' });
  }
});

// 🔹 League start date at 12:00 AM PT on July 23 (UTC-7 = 07:00 UTC)
const LEAGUE_START_DATE = new Date('2025-07-23T07:00:00Z');

async function trimMatchesToLimit(limit = 10) {
  const snapshot = await db.collection('matches').get();

  // Step 1: Build clubMatchMap { clubId: [match objects] }
  const clubMatchMap = {};
  const matchIdMap = {}; // For deduplication

  for (const doc of snapshot.docs) {
    const match = doc.data();
    const ts = match.timestamp || match.matchTimestamp;
    const date = ts ? new Date(ts * 1000) : null;
    if (!date || date < LEAGUE_START_DATE) continue;

    const matchId = doc.id;
    matchIdMap[matchId] = doc;

    for (const clubId of Object.keys(match.clubs || {})) {
      if (!clubMatchMap[clubId]) clubMatchMap[clubId] = [];
      clubMatchMap[clubId].push({ doc, ts });
    }
  }

  // Step 2: Sort matches per club by timestamp (oldest first)
  for (const clubId in clubMatchMap) {
    clubMatchMap[clubId].sort((a, b) => a.ts - b.ts);
  }

  // Step 3: Determine which matches are excess for any club
  const uniqueExcessMatchIds = new Set();

  for (const clubId of CLUB_IDS) {
    const matches = clubMatchMap[clubId] || [];
    console.log(`📊 ${CLUB_NAMES[clubId] || clubId} has ${matches.length} league matches.`);

    if (matches.length <= limit) {
      console.log(`✅ ${CLUB_NAMES[clubId] || clubId} is within limit.`);
      continue;
    }

    const excessMatches = matches.slice(limit);
    for (const { doc } of excessMatches) {
      uniqueExcessMatchIds.add(doc.id);
    }
  }

  if (uniqueExcessMatchIds.size === 0) {
    console.log('✅ No excess matches to delete across all clubs.');
    return;
  }

  // Step 4: Delete excess matches
  const batch = db.batch();
  for (const matchId of uniqueExcessMatchIds) {
    const ref = db.collection('matches').doc(matchId);
    batch.delete(ref);
    console.log(`🗑️ Deleting excess match ${matchId}`);
  }

  await batch.commit();
  console.log(`✂️ Deleted ${uniqueExcessMatchIds.size} excess match(es) to enforce cap.`);
}




// 🔹 Utility: Check if match is after league start
function isAfterLeagueStart(match) {
  const ts = match.timestamp || match.matchTimestamp;
  if (!ts) return false;
  const date = new Date(ts * 1000);
  return date >= LEAGUE_START_DATE;
}


async function deleteMatchesForClubBeforeDate(clubId, cutoffDateStr) {
  const cutoffDate = new Date(cutoffDateStr);
  const snapshot = await db.collection('matches').get();

  const toDelete = snapshot.docs.filter(doc => {
    const match = doc.data();
    const ts = match.timestamp || match.matchTimestamp;
    const matchDate = ts ? new Date(ts * 1000) : null;

    return (
      matchDate &&
      matchDate < cutoffDate &&
      (match.clubId === clubId ||
       match.opponentId === clubId ||
       (match.clubs && match.clubs[clubId]))
    );
  });

  if (!toDelete.length) {
    console.log(`❌ No matches to delete for club ${clubId} before ${cutoffDate.toISOString()}`);
    return;
  }

  const batch = db.batch();
  toDelete.forEach(doc => {
    console.log(`🗑️ Deleting match ${doc.id} for club ${clubId}`);
    batch.delete(doc.ref);
  });

  await batch.commit();
  console.log(`✅ Deleted ${toDelete.length} matches for club ${clubId} before ${cutoffDate.toISOString()}`);
}


// 🔹 Clean matches before league start
async function cleanOldMatches() {
  const snapshot = await db.collection('matches').get();
  const batch = db.batch();

  snapshot.docs.forEach(doc => {
    const match = doc.data();
    const ts = match.timestamp || match.matchTimestamp;
    const date = ts ? new Date(ts * 1000) : null;

    if (date && date < LEAGUE_START_DATE) {
      batch.delete(doc.ref);
    }
  });

  if (batch._ops?.length) {
    await batch.commit();
    console.log(`[${new Date().toISOString()}] Old matches cleaned.`);
  } else {
    console.log(`[${new Date().toISOString()}] No old matches to delete.`);
  }
}
app.post('/api/clean-old-matches', async (req, res) => {
  try {
    await cleanOldMatches();
    res.status(200).send({ message: 'Old matches cleaned.' });
  } catch (error) {
    console.error('Error cleaning old matches:', error.message);
    res.status(500).send({ error: 'Failed to clean old matches.' });
  }
});


const PORT = process.env.PORT || 3000;
app.use(express.static('public'));

const app = express();
app.use(cors());

// Serve static assets
app.use(express.static(path.join(__dirname)));

// Placeholder API endpoint
app.get('/api/status', (req, res) => {
  res.json({ status: 'ok', message: 'Firebase disabled' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
