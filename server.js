// server.js — Pro Clubs League Backend
const express = require("express");
const path = require("path");
const cors = require("cors");
const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));

// Firebase Admin (make sure FIREBASE_KEY_JSON is set in Render env vars)
const admin = require("firebase-admin");
let serviceAccount;
if (process.env.FIREBASE_KEY_JSON) {
  serviceAccount = JSON.parse(process.env.FIREBASE_KEY_JSON);
} else {
  throw new Error("Missing FIREBASE_KEY_JSON environment variable");
}
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}
const db = admin.firestore();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// --- EA API Player Aggregation ---
const CLUB_IDS = [
  2491998, 1527486, 1969494, 2086022, 2462194, 5098824,
  4869810, 576007, 4933507, 4824736, 481847, 3050467,
  4154835, 3638105, 55408, 4819681, 35642,
];

const EA_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  Referer: "https://www.ea.com/",
  Origin: "https://www.ea.com",
  Connection: "keep-alive",
};

async function fetchClubPlayers(clubId) {
  const url = `https://proclubs.ea.com/api/fc/members/stats?platform=common-gen5&clubId=${clubId}`;
  try {
    const res = await fetch(url, { headers: EA_HEADERS });
    if (!res.ok) throw new Error(`EA responded ${res.status}`);
    const data = await res.json();
    console.log(`✅ Club ${clubId} -> ${data.members?.length || 0} players`);
    return data.members || [];
  } catch (err) {
    console.error(`❌ Failed fetching club ${clubId}:`, err.message);
    return [];
  }
}

app.get("/api/players", async (req, res) => {
  try {
    let allPlayers = [];
    for (const clubId of CLUB_IDS) {
      const players = await fetchClubPlayers(clubId);
      allPlayers = allPlayers.concat(players);
      // pause 500ms to avoid EA API throttling
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    res.json({ members: allPlayers });
  } catch (err) {
    console.error("❌ EA API aggregation failed:", err);
    res.status(500).json({ error: "Failed to fetch players" });
  }
});

// --- Example Firestore Route ---
app.get("/api/matches", async (req, res) => {
  try {
    const snapshot = await db
      .collection("matches")
      .orderBy("timestamp", "desc")
      .limit(50)
      .get();
    const matches = snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));
    res.json(matches);
  } catch (err) {
    console.error("❌ Failed fetching matches:", err);
    res.status(500).json({ error: "Failed fetching matches" });
  }
});

// Health check
app.get("/api/status", (req, res) => {
  res.json({ status: "ok" });
});

app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});
