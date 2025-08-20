const { db } = require('../firebaseAdmin');

// const FREEZE_TIME = new Date('2025-07-26T01:00:00-07:00').getTime();
// if (Date.now() >= FREEZE_TIME) {
//   console.log('📌 League frozen. Skipping snapshot generation.');
//   process.exit(0);
// }


const CLUB_ID_MAP = {
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
  '55408': 'Elite VT',
  '4819681': 'EVERYTHING DEAD',
  '35642': 'EBK FC'
};

function getTeamName(clubId) {
  return CLUB_ID_MAP[String(clubId)] || null;
}

function isKnownClub(clubId) {
  return getTeamName(clubId) !== null;
}

function parseMatch(rawMatch) {
  const clubs = rawMatch.clubs;
  if (!clubs || Object.keys(clubs).length !== 2) return null;

  const teamIds = Object.keys(clubs);
  const homeId = teamIds[0];
  const awayId = teamIds[1];

  const home = {
    id: homeId,
    name: getTeamName(homeId),
    goals: parseInt(clubs[homeId].goals),
    players: rawMatch.players?.[homeId] || {},
  };

  const away = {
    id: awayId,
    name: getTeamName(awayId),
    goals: parseInt(clubs[awayId].goals),
    players: rawMatch.players?.[awayId] || {},
  };

  return { matchId: rawMatch.matchId, home, away };
}

const standings = {};
const scorers = {};
const assisters = {};

function initTeam(teamId, teamName) {
  standings[teamId] = {
    name: teamName,
    pts: 0,
    gp: 0,
    wins: 0,
    draws: 0,
    losses: 0,
    goalsFor: 0,
    goalsAgainst: 0
  };
}

function addTeamResult(teamId, result) {
  const team = standings[teamId];
  if (!team) return;
  team.gp += 1;

  if (result === 'win') {
    team.pts += 3;
    team.wins += 1;
  } else if (result === 'draw') {
    team.pts += 1;
    team.draws += 1;
  } else if (result === 'loss') {
    team.losses += 1;
  }
}

function recordGoals(playersObj, target, stat = 'goals') {
  for (const [playerId, player] of Object.entries(playersObj || {})) {
    if (!player || !player.playername) continue;

    const amount = parseInt(player[stat] || '0');
    if (amount > 0) {
      const name = player.playername;
      const key = `${name}~${playerId}`;
      target[key] = (target[key] || 0) + amount;
    }
  }
}

async function loadMatchesFromFirestore() {
  const snapshot = await db.collection('matches').get();
  return snapshot.docs.map(doc => doc.data());
}

async function updateLeagueSnapshot() {
  const snapshotRef = db.collection('snapshots').doc('league');
  const matches = await loadMatchesFromFirestore();

  console.log(`📦 Loaded ${matches.length} matches`);

  for (const rawMatch of matches) {
    const match = parseMatch(rawMatch);
    if (!match || !match.home || !match.away) {
      console.warn('⚠️ Skipping invalid match: missing team data', rawMatch);
      continue;
    }

    const homeId = match.home.id;
    const awayId = match.away.id;
    const homeName = getTeamName(homeId);
    const awayName = getTeamName(awayId);
    const homeGoals = match.home.goals || 0;
    const awayGoals = match.away.goals || 0;

    let homeResult = 'draw', awayResult = 'draw';
    if (homeGoals > awayGoals) homeResult = 'win', awayResult = 'loss';
    else if (homeGoals < awayGoals) homeResult = 'loss', awayResult = 'win';

    if (isKnownClub(homeId) && !standings[homeId]) initTeam(homeId, homeName);
    if (isKnownClub(awayId) && !standings[awayId]) initTeam(awayId, awayName);

    if (isKnownClub(homeId)) addTeamResult(homeId, homeResult);
    if (isKnownClub(awayId)) addTeamResult(awayId, awayResult);

    if (isKnownClub(homeId)) {
      standings[homeId].goalsFor += homeGoals;
      standings[homeId].goalsAgainst += awayGoals;
    }
    if (isKnownClub(awayId)) {
      standings[awayId].goalsFor += awayGoals;
      standings[awayId].goalsAgainst += homeGoals;
    }

    recordGoals(match.home.players, scorers, 'goals');
    recordGoals(match.away.players, scorers, 'goals');
    recordGoals(match.home.players, assisters, 'assists');
    recordGoals(match.away.players, assisters, 'assists');
  }

  const formatLeaders = (statMap, label) => {
    return Object.entries(statMap)
      .map(([key, count]) => {
        const [name, id] = key.split('~');
        return { name, playerId: id, [label]: count };
      })
      .sort((a, b) => b[label] - a[label])
      .slice(0, 10);
  };

  const topScorersArr = formatLeaders(scorers, 'goals');
  const topAssistersArr = formatLeaders(assisters, 'assists');

  const table = Object.entries(standings)
    .map(([id, stats]) => ({
      id,
      ...stats,
      points: stats.pts,
      ties: stats.draws,
      goals: stats.goalsFor
    }))
    .sort((a, b) => b.pts - a.pts || b.wins - a.wins);

  console.log(`✅ League snapshot updated.`);
  table.forEach(t => console.log(`- ${t.name}: ${t.pts} pts`));

  if (topScorersArr.length > 0) {
    console.log(`🎯 Top Scorers:`);
    topScorersArr.forEach(p => console.log(`- ${p.name} (${p.goals} goals)`));
  }

  if (topAssistersArr.length > 0) {
    console.log(`🅰️ Top Assisters:`);
    topAssistersArr.forEach(p => console.log(`- ${p.name} (${p.assists} assists)`));
  }

await snapshotRef.set({
    updatedAt: Date.now(),
    standings: table,
    topScorers: topScorersArr,
    topAssisters: topAssistersArr
  });
}

// ✅ Fix entry point
if (require.main === module) {
  updateLeagueSnapshot().catch(console.error);
}

module.exports = updateLeagueSnapshot;
