// cron-season-update.js

const { db } = require('./firebaseAdmin'); // ✅ use firebaseAdmin instead of ./firebase
const FREEZE_TIME = new Date('2025-07-26T01:00:00-07:00').getTime();

// 🛑 TEMPORARILY DISABLING LEAGUE FREEZE
// if (Date.now() >= FREEZE_TIME) {
//   console.log('📌 League frozen. Skipping snapshot generation.');
//   process.exit(0);
// }

// ----------------------------
// Helpers
// ----------------------------
function normalizeRole(pos) {
  if (!pos) return 'Unknown';
  pos = pos.toLowerCase();
  if (pos.includes('attack') || pos.includes('forward')) return 'Attack';
  if (pos.includes('mid')) return 'Midfield';
  if (pos.includes('def')) return 'Defence';
  if (pos.includes('keeper') || pos.includes('gk')) return 'Goalkeeper';
  return 'Unknown';
}

// ----------------------------
// League Setup
// ----------------------------
const CLUB_IDS = [
  2491998, 1527486, 1969494, 2086022, 2462194, 5098824,
  4869810, 576007, 4933507, 4824736, 481847, 3050467,
  4154835, 3638105, 55408, 4819681, 35642
];

const CLUB_NAMES = {
  2491998: 'Royal Republic',
  1527486: 'Gungan FC',
  1969494: 'Club Frijol',
  2086022: 'Brehemen',
  2462194: 'Costa Chica FC',
  5098824: 'Sporting de la ma',
  4869810: 'Afc Tekki',
  576007: 'Ethabella FC',
  4933507: 'Loss Toyz',
  4824736: 'GoldenGoals FC',
  481847: 'Rooney tunes',
  3050467: 'invincible afc',
  4154835: 'khalch Fc',
  3638105: 'Real mvc',
  55408: 'Elite VT',
  4819681: 'EVERYTHING DEAD',
  35642: 'EBK FC'
};

// ----------------------------
// Main Job
// ----------------------------
async function updateSeasonSnapshot() {
  try {
    // 1. Load matches from Firestore
    const snapshot = await db.collection('matches')
      .orderBy('timestamp', 'desc')
      .limit(1000)
      .get();

    const matches = snapshot.docs.map(doc => doc.data());

    // 2. Build league table
    const leagueTable = {};
    for (const clubId of CLUB_IDS) {
      leagueTable[clubId] = {
        id: clubId,
        name: CLUB_NAMES[clubId] || `Club ${clubId}`,
        played: 0,
        wins: 0,
        ties: 0,
        losses: 0,
        goals: 0,
        goalsAgainst: 0,
        points: 0,
        winPercent: 0
      };
    }

    for (const match of matches) {
      const clubs = match.clubs || {};
      const [clubAId, clubBId] = Object.keys(clubs);
      if (!CLUB_IDS.includes(Number(clubAId)) && !CLUB_IDS.includes(Number(clubBId))) continue;

      const clubA = clubs[clubAId];
      const clubB = clubs[clubBId];

      const goalsA = Number(clubA.goals || 0);
      const goalsB = Number(clubB.goals || 0);

      if (leagueTable[clubAId]) {
        leagueTable[clubAId].goals += goalsA;
        leagueTable[clubAId].goalsAgainst += goalsB;
        leagueTable[clubAId].played++;
      }
      if (leagueTable[clubBId]) {
        leagueTable[clubBId].goals += goalsB;
        leagueTable[clubBId].goalsAgainst += goalsA;
        leagueTable[clubBId].played++;
      }

      if (goalsA > goalsB) {
        if (leagueTable[clubAId]) {
          leagueTable[clubAId].wins++;
          leagueTable[clubAId].points += 3;
        }
        if (leagueTable[clubBId]) leagueTable[clubBId].losses++;
      } else if (goalsB > goalsA) {
        if (leagueTable[clubBId]) {
          leagueTable[clubBId].wins++;
          leagueTable[clubBId].points += 3;
        }
        if (leagueTable[clubAId]) leagueTable[clubAId].losses++;
      } else {
        if (leagueTable[clubAId]) {
          leagueTable[clubAId].ties++;
          leagueTable[clubAId].points += 1;
        }
        if (leagueTable[clubBId]) {
          leagueTable[clubBId].ties++;
          leagueTable[clubBId].points += 1;
        }
      }
    }

    // Win % for each team
    for (const clubId in leagueTable) {
      const t = leagueTable[clubId];
      t.winPercent = t.played > 0 ? (t.wins / t.played) : 0;
    }

    const standings = Object.values(leagueTable).sort((a, b) => {
      const diffA = a.goals - a.goalsAgainst;
      const diffB = b.goals - b.goalsAgainst;
      if (b.points !== a.points) return b.points - a.points;
      if (diffB !== diffA) return diffB - diffA;
      return b.goals - a.goals;
    });

    // 3. Build playoff (semi-finals + final from top 4)
    const top4 = standings.slice(0, 4);
    const semiFinals = [
      { home: top4[0], away: top4[3], score: 'TBD' },
      { home: top4[1], away: top4[2], score: 'TBD' }
    ];
    const final = [{ home: 'Winner SF1', away: 'Winner SF2', score: 'TBD' }];

    // 4. Player stats
    const stats = {};
    for (const match of matches) {
      if (!match.players) continue;

      for (const clubId in match.players) {
        for (const playerId in match.players[clubId]) {
          const p = match.players[clubId][playerId];
          const name = p.playername || 'Unknown';
          const role = normalizeRole(p.pos);
          const club = CLUB_NAMES[clubId] || 'Unknown';

          if (!stats[name]) {
            stats[name] = {
              name,
              club,
              goals: 0,
              assists: 0,
              saves: 0,
              cleanSheets: 0,
              matches: 0,
              roles: {},
              winCount: 0,
              team: clubId
            };
          }

          stats[name].goals += Number(p.goals || 0);
          stats[name].assists += Number(p.assists || 0);
          stats[name].saves += Number(p.saves || 0);
          stats[name].matches += 1;
          stats[name].roles[role] = (stats[name].roles[role] || 0) + 1;

          const clubResult = match.clubs?.[clubId];
          const oppClubId = Object.keys(match.clubs).find(id => id !== clubId);
          const oppGoals = Number(match.clubs?.[oppClubId]?.goals || 0);
          const teamGoals = Number(clubResult?.goals || 0);

          if (teamGoals > oppGoals) stats[name].winCount++;
          if (role === 'Goalkeeper' && oppGoals === 0) stats[name].cleanSheets++;
        }
      }
    }

    // Save or log results (replace with Firestore write if needed)
    console.log('Standings:', standings);
    console.log('SemiFinals:', semiFinals);
    console.log('Final:', final);
    console.log('Player Stats:', stats);

  } catch (err) {
    console.error('Failed to update season snapshot:', err);
  }
}

module.exports = updateSeasonSnapshot;
