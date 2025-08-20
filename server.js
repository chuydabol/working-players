const express = require('express');
const path = require('path');
const cors = require('cors');

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
