const express = require('express');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
const path = require('path');
const admin = require('firebase-admin');
const cors = require('cors');
const cron = require('node-cron');

const app = express(); // ✅ Initialize Express
const serviceAccount = require('./config/firebase-service-account.json');

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

app.use(cors());
app.use(express.static(path.join(__dirname)));
app.use(express.json());

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Club list
const CLUB_IDS = [
  '2491998', // Royal Republic
  '1527486', // Gungan FC
  '1969494', // Club Frijol
  '2086022', // Brehemen
  '2462194', // Costa Chica FC
  '5098824', // Sporting de la ma
  '4869810', // Afc Tekki
  '576007',  // Ethabella FC (new)
   '481847', //Rooney tunes
  '3050467', //invincible afc
   '4933507',//Loss Toyz
  '4824736', //GoldenGoals FC
  '4154835', //khalch Fc
  '3638105', //real mvc
   '55408', //Elite VT
   '4819681', //EVERYTHING DEAD
    '35642', //EBK FC 
];
const CLUB_NAMES = {
  '2491998': 'Royal Republic',
  '1527486': 'Gungan FC',
  '1969494': 'Club Frijol',
  '2086022': 'Brehemen',
  '2462194': 'Costa Chica FC',
  '5098824': 'Sporting de la ma',
  '4869810': 'Afc Tekki',
  '576007': 'Ethabella FC',
  '4933507': 'Loss Toyz',
  '4824736': 'GoldenGoals FC',
  '481847': 'Rooney tunes',
  '3050467': 'invincible afc',
  '4154835': 'khalch Fc',
  '3638105': 'Real mvc',
  '55408':'Elite VT',
  '4819681':'EVERYTHING DEAD',
  '35642':'EBK FC',

    
};



async function fetchPlayersForClub(clubId) {
  const url = `https://proclubs.ea.com/api/fc/members/stats?platform=common-gen5&clubId=${clubId}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!res.ok) throw new Error(`Failed fetching players for club ${clubId}, status: ${res.status}`);
    return res.json();
  } catch (err) {
    clearTimeout(timeoutId);
    throw err;
  }
}
// ✅ Place function here
function getRoleFromPosition(positionId) {
  if (typeof positionId !== 'number' || isNaN(positionId)) return "Unknown";
  if (positionId === 0) return "Goalkeeper";
  if ([1, 2, 3, 4, 5, 6].includes(positionId)) return "Defender";
  if ([7, 8, 9, 10, 11, 12, 13, 14, 15].includes(positionId)) return "Midfielder";
  if ([16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27].includes(positionId)) return "Forward";
  return "Unknown";
}

app.get('/api/players', async (req, res) => {
  try {
    const results = await Promise.all(CLUB_IDS.map(id =>
      fetchPlayersForClub(id).catch(e => {
        console.error(`[${new Date().toISOString()}] Error fetching club ${id}: ${e.message}`);
        return { members: [] };
      })
    ));

    const allMembers = results.flatMap(r => Array.isArray(r.members) ? r.members : []);

    const unique = new Map();
    for (const player of allMembers) {
      if (player?.name && !unique.has(player.name)) {
        const posId = player?.proPos ? Number(player.proPos) : null;
        player.role = getRoleFromPosition(posId);
        unique.set(player.name, player);
      }
    }

    res.json({ members: Array.from(unique.values()) });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] /api/players error:`, error);
    res.status(500).json({ error: 'Failed to fetch player stats' });
  }
});


 async function fetchMatches(clubId) {
  try {
    const url = `https://proclubs.ea.com/api/fc/clubs/matches?matchType=leagueMatch&platform=common-gen5&clubIds=${clubId}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`Status ${response.status}`);
    }

    const matches = await response.json();

    let matchesArray = [];

    if (Array.isArray(matches)) {
      matchesArray = matches;
    } else if (typeof matches === 'object' && matches !== null) {
      for (const key of Object.keys(matches)) {
        if (Array.isArray(matches[key])) {
          matchesArray = matchesArray.concat(matches[key]);
        }
      }
    }

    return matchesArray;
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Error fetching matches for club ${clubId}:`, error.message);
    return [];
  }
}

async function saveNewMatches(matches) {
  const BATCH_LIMIT = 400;
  let savedCount = 0;

  // 🔄 Load existing match counts per club
  const matchCollection = db.collection('matches');
  const snapshot = await matchCollection.get();
  const existingMatchIds = new Set(snapshot.docs.map(doc => doc.id));
  const matchCountPerClub = {};

  snapshot.docs.forEach(doc => {
  const data = doc.data();
  if (!isAfterLeagueStart(data)) return;
  const clubs = data.clubs || {};
  Object.keys(clubs).forEach(clubId => {
    matchCountPerClub[clubId] = (matchCountPerClub[clubId] || 0) + 1;
  });
});


  for (let i = 0; i < matches.length; i += BATCH_LIMIT) {
    const batch = db.batch();
    const chunk = matches.slice(i, i + BATCH_LIMIT);

    for (const match of chunk) {
      const matchId = match.matchId?.toString() || match.id?.toString();
      if (!matchId || existingMatchIds.has(matchId)) continue;

      const SKIP_BEFORE = {
        '3638105': new Date('2025-07-23T10:00:00Z'),
      };

      const ts = match.timestamp || match.matchTimestamp;
      const matchDate = ts ? new Date(ts * 1000) : null;
      const clubsInMatch = match.clubs ? Object.keys(match.clubs) : [];

      const shouldSkip = clubsInMatch.some(clubId => {
        const cutoff = SKIP_BEFORE[clubId];
        return cutoff && matchDate && matchDate < cutoff;
      });

      if (shouldSkip) {
        console.log(`⏩ Skipping match ${matchId} before cutoff`);
        continue;
      }

      if (!isAfterLeagueStart(match)) continue;

      const clubs = match.clubs || {};
      const clubIdsInMatch = Object.keys(clubs);
      if (clubIdsInMatch.length !== 2) continue;
      if (!clubIdsInMatch.some(id => CLUB_IDS.includes(id))) continue;

      // 🚫 Skip if either club already has 10 matches
      const anyOverLimit = clubIdsInMatch.some(clubId => (matchCountPerClub[clubId] || 0) >= 10);
      if (anyOverLimit) {
        console.log(`⛔ Skipping match ${matchId} because one or more clubs already have 10 matches`);
        continue;
      }

      // 🧼 Patch missing club names
      for (const id of clubIdsInMatch) {
        if (!clubs[id].details) clubs[id].details = {};
        if (!clubs[id].details.name || clubs[id].details.name === id) {
          clubs[id].details.name = CLUB_NAMES[id] || `Club ${id}`;
        }
      }

      const matchRef = db.collection('matches').doc(matchId);
      batch.set(matchRef, match);
      savedCount++;

      // 🧮 Update in-memory count so we stay within cap
      clubIdsInMatch.forEach(id => {
        matchCountPerClub[id] = (matchCountPerClub[id] || 0) + 1;
      });
    }

    // ✅ Commit this batch if it has any operations
    if (batch._ops?.length > 0) {
      await batch.commit();
    }
  }

  if (savedCount === 0) {
    console.log(`[${new Date().toISOString()}] No new matches to save.`);
  } else {
    console.log(`[${new Date().toISOString()}] Saved ${savedCount} new matches.`);
  }

  return savedCount;
}


app.get('/api/update-matches', async (req, res) => {
  try {
    // ❄️ Freeze logic — uncomment to enable playoff freeze
    // const LEAGUE_FREEZE_TIMESTAMP = new Date('2025-07-26T01:00:00-07:00').getTime();
    // if (Date.now() >= LEAGUE_FREEZE_TIMESTAMP) {
    //   console.log('📌 League is frozen. No more updates.');
    //   return res.status(403).json({ message: 'League stats are frozen.' });
    // }

    const matchCollection = db.collection('matches');

    // 🔧 Step 1: Trim to 10 matches per club before fetching anything
    await trimMatchesToLimit(10);

    // 🔁 Optional: Wait a bit for Firestore indexing to settle
    await new Promise(resolve => setTimeout(resolve, 500));

    // 🔄 Step 2: Recalculate match count after trimming
    const updatedSnapshot = await matchCollection.get();
    const existingMatches = new Set(updatedSnapshot.docs.map(doc => doc.id));
    let matchCountPerClub = {};
   updatedSnapshot.docs.forEach(doc => {
  const match = doc.data();
  if (!isAfterLeagueStart(match)) return;
  const clubsInMatch = Object.keys(match.clubs || {});
  clubsInMatch.forEach(clubId => {
    matchCountPerClub[clubId] = (matchCountPerClub[clubId] || 0) + 1;
  });
});


    // ✅ Your code continues here...

    // 🔄 Step 3: Loop through clubs and only fetch if under cap
    const batch = db.batch();
    let totalNewMatches = 0;
    const CUTOFF_CLUB_ID = '3638105';
    const CUTOFF_TIMESTAMP = new Date('2025-07-23T10:00:00Z').getTime();

    for (const clubId of CLUB_IDS) {
      const currentCount = matchCountPerClub[clubId] || 0;
      if (currentCount >= 10) {
        console.log(`⛔ ${CLUB_NAMES[clubId] || clubId} already has ${currentCount} matches. Skipping fetch.`);
        continue;
      }

      const newMatches = await fetchMatches(clubId);
      const filteredMatches = newMatches.filter(m => {
        const matchId = m.matchId?.toString() || m.id?.toString();
        if (!matchId || existingMatches.has(matchId)) return false;

        if (clubId === CUTOFF_CLUB_ID) {
          const ts = m.timestamp || m.matchTimestamp;
          if (!ts || new Date(ts * 1000).getTime() < CUTOFF_TIMESTAMP) {
            return false;
          }
        }

        return true;
      });

      const allowedNewCount = 10 - currentCount;
      const limitedMatches = filteredMatches.slice(0, allowedNewCount);

      for (const match of limitedMatches) {
        const matchId = match.matchId?.toString() || match.id?.toString();
        if (!matchId) continue;

        const matchRef = db.collection('matches').doc(matchId);
        batch.set(matchRef, match);
        totalNewMatches++;
      }
    }

    if (totalNewMatches === 0) {
      console.log(`✅ No new matches to save.`);
      return res.status(200).send('No new matches to save.');
    }

    await batch.commit();
    console.log(`✅ Saved ${totalNewMatches} new matches.`);

    // 🚫 No need to trim again — already done before
    return res.status(200).send(`Saved ${totalNewMatches} new matches.`);
  } catch (error) {
    console.error('❌ Error updating matches:', error);
    res.status(500).json({ error: 'Failed to update matches' });
  }
});




app.get('/api/league', async (req, res) => {
  try {
    const doc = await db.collection('snapshots').doc('league').get();
    if (!doc.exists) {
      return res.status(404).json({ error: 'No league snapshot found' });
    }
    res.json(doc.data());
  } catch (err) {
    console.error('❌ Error loading league:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});


app.get('/api/season', async (req, res) => {
  try {
    const doc = await db.collection('meta').doc('season').get();
    if (!doc.exists) return res.status(404).json({ error: 'No season snapshot found' });

    res.json(doc.data());
  } catch (err) {
    console.error('❌ Failed to load season snapshot:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});



// Utility function
function normalizeRole(pos) {
  if (!pos) return 'Unknown';
  const position = pos.toLowerCase();
  if (position.includes('back') || position.includes('def')) return 'Defender';
  if (position.includes('mid')) return 'Midfielder';
  if (position.includes('wing') || position.includes('st') || position.includes('cam') || position.includes('cf') || position.includes('att')) return 'Attacker';
  return 'Unknown';
}


// Hourly league rebuild
cron.schedule('10 * * * *', async () => {
  try {
    await updateLeagueSnapshot();
  } catch (err) {
    console.error('❌ League cron update failed:', err);
  }
});


const updateSeasonSnapshot = require('./cron-season-update');

cron.schedule('15 * * * *', async () => {
  try {
    await updateSeasonSnapshot();
  } catch (err) {
    console.error('❌ Season update cron failed:', err);
  }
});


const clubs = [
  { id: '576007', name: 'Ethabella FC' },
  { id: '4933507', name: 'Loss Toyz' },
  { id: '2491998', name: 'Royal Republic' },
  { id: '1969494', name: 'Club Frijol' },
  { id: '2086022', name: 'Brehemen' },
  { id: '2462194', name: 'Costa Chica FC' },
  { id: '5098824', name: 'Sporting de la ma' },
  { id: '4869810', name: 'Afc Tekki' },
  { id: '1527486', name: 'Gungan FC' },
  { id: '4824736', name: 'GoldenGoals FC' },
  { id: '481847', name: 'Rooney tunes' },
  { id: '3050467', name: 'invincible afc' },
  { id: '4154835', name: 'khalch Fc' },
  { id: '3638105', name: 'Real mvc' },
  { id: '55408', name: 'Elite VT' },
  { id: '4819681', name: 'EVERYTHING DEAD' },
  { id: '35642', name: 'EBK FC' }
];



// Auto update every 10 minutes
cron.schedule('*/10 * * * *', async () => {
  console.log(`[${new Date().toISOString()}] Auto update starting...`);
  try {
    const updateLeagueSnapshot = require('./utils/updateLeagueSnapshot');
    await cleanOldMatches();

    for (const club of clubs) {
      const matches = await fetchMatches(club.id);
      await saveNewMatches(matches);
    }

    console.log(`[${new Date().toISOString()}] ✅ Auto update complete.`);
  } catch (error) {
    console.error(`[${new Date().toISOString()}] ❌ Auto update failed: ${error.message}`);
  }
});

app.listen(PORT, () => {
  console.log(`[${new Date().toISOString()}] Server running at http://localhost:${PORT}`);

  (async () => {
    try {
      await cleanOldMatches();
      await deleteMatchesForClubBeforeDate('3638105', '2025-07-23T10:00:00Z');

      let allMatches = [];
      for (const clubId of CLUB_IDS) {
        const matches = await fetchMatches(clubId);
        allMatches = allMatches.concat(matches);
      }

      await saveNewMatches(allMatches);
      console.log(`[${new Date().toISOString()}] ✅ Initial sync complete.`);

      await trimMatchesToLimit(10);
      console.log(`[${new Date().toISOString()}] ✂️ Trimmed matches to limit.`);
    } catch (error) {
      console.error(`[${new Date().toISOString()}] ❌ Initial sync error:`, error.message);
    }
  })(); // closes IIFE
});     // closes app.listen
