const express = require('express');
const { z } = require('zod');
const { authMiddleware } = require('../middleware/auth');
const pushService = require('../services/pushService');

const router = express.Router();

// Public — browser fetches this before subscribing.
router.get('/vapid-key', (_req, res) => {
  if (!pushService.isEnabled()) return res.status(503).json({ error: 'Push not configured', code: 'PUSH_DISABLED' });
  res.json({ publicKey: pushService.publicKey() });
});

router.use(authMiddleware);

router.post('/subscribe', (req, res, next) => {
  try {
    const body = z.object({
      subscription: z.object({
        endpoint: z.string().url().max(1024),
        keys: z.object({
          p256dh: z.string().min(1).max(200),
          auth: z.string().min(1).max(200),
        }),
      }),
    }).parse(req.body);
    res.json(pushService.saveSubscription(req.userId, body.subscription, req.get('user-agent')));
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: 'Validation failed', issues: err.issues });
    next(err);
  }
});

router.post('/unsubscribe', (req, res, next) => {
  try {
    const body = z.object({ endpoint: z.string().url().max(1024) }).parse(req.body);
    res.json(pushService.removeSubscription(body.endpoint));
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: 'Validation failed', issues: err.issues });
    next(err);
  }
});

router.get('/subscriptions', (req, res, next) => {
  try { res.json({ subscriptions: pushService.listForUser(req.userId) }); }
  catch (err) { next(err); }
});

// Dev-only "send test push to myself" endpoint — useful when wiring up
// your device the first time. Disabled in prod unless explicitly allowed.
router.post('/test', async (req, res, next) => {
  try {
    if (process.env.NODE_ENV === 'production' && process.env.PUSH_TEST_ENABLED !== '1') {
      return res.status(403).json({ error: 'Disabled in prod' });
    }
    const out = await pushService.sendToUser(req.userId, {
      title: '🚀 CHM push test',
      body: 'Если видишь это — push-уведомления работают.',
      url: '/settings.html',
    });
    res.json(out);
  } catch (err) { next(err); }
});

module.exports = router;
