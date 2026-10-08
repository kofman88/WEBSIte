const express = require('express');

const router = express.Router();

// Public, unauthenticated endpoints. The old leaderboard, public-profile and
// market-context endpoints were removed in M0 (port plan §5). The Free plan's
// public stats / health for the web app arrive with the engine (M10).

module.exports = router;
