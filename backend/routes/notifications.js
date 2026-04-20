const express = require('express');
const { z } = require('zod');
const { authMiddleware } = require('../middleware/auth');
const notifications = require('../services/notificationsService');
const notifier = require('../services/notifier');

const router = express.Router();
router.use(authMiddleware);

function handleErr(err, res, next) {
  if (err instanceof z.ZodError) {
    return res.status(400).json({ error: 'Validation failed', code: 'VALIDATION_ERROR', issues: err.issues });
  }
  return next(err);
}

router.get('/', (req, res, next) => {
  try {
    const q = z.object({
      limit: z.coerce.number().int().min(1).max(100).default(30),
      offset: z.coerce.number().int().min(0).default(0),
      unread: z.coerce.boolean().default(false),
    }).parse(req.query);
    res.json({
      notifications: notifications.listForUser(req.userId, { limit: q.limit, offset: q.offset, unreadOnly: q.unread }),
      unreadCount: notifications.unreadCount(req.userId),
    });
  } catch (err) { handleErr(err, res, next); }
});

router.get('/unread-count', (req, res, next) => {
  try { res.json({ count: notifications.unreadCount(req.userId) }); }
  catch (err) { handleErr(err, res, next); }
});

router.post('/:id/read', (req, res, next) => {
  try {
    const id = z.coerce.number().int().positive().parse(req.params.id);
    res.json(notifications.markRead(req.userId, id));
  } catch (err) { handleErr(err, res, next); }
});

router.post('/read-all', (req, res, next) => {
  try { res.json(notifications.markAllRead(req.userId)); }
  catch (err) { handleErr(err, res, next); }
});

router.delete('/:id', (req, res, next) => {
  try {
    const id = z.coerce.number().int().positive().parse(req.params.id);
    res.json(notifications.remove(req.userId, id));
  } catch (err) { handleErr(err, res, next); }
});

// Notification preferences (email/telegram opt-in/out per type)
router.get('/prefs', (req, res) => {
  res.json({ prefs: notifier.getPrefs(req.userId), defaults: notifier.defaults() });
});
router.put('/prefs', (req, res) => {
  res.json({ prefs: notifier.savePrefs(req.userId, req.body || {}) });
});

module.exports = router;
