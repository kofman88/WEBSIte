const { ZodError } = require('zod');
const logger = require('../utils/logger');

// Single source of truth for route-level error responses.
// Replaces 15 near-identical handleErr() copies that drifted across
// /backend/routes/*.js (some lost `code`, some lost issue mapping, etc).
//
// Recognized error shapes:
//   - ZodError → 400 with parsed issues + VALIDATION_ERROR code
//   - { statusCode, message, code?, requiredPlan? } → JSON with those fields
//   - anything else → next(err) so Express's global handler logs/500s it
//
// Usage in a route:
//   const handleErr = require('../middleware/handleErr');
//   router.get('/', auth, (req, res, next) => {
//     try { ... } catch (err) { handleErr(err, res, next); }
//   });
function handleErr(err, res, next) {
  if (err instanceof ZodError) {
    return res.status(400).json({
      error: 'Validation failed',
      code: 'VALIDATION_ERROR',
      issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  if (err && err.statusCode) {
    return res.status(err.statusCode).json({
      error: err.message,
      ...(err.code ? { code: err.code } : {}),
      ...(err.requiredPlan ? { requiredPlan: err.requiredPlan } : {}),
    });
  }
  if (err) logger.error('route error', { msg: err.message, stack: err.stack });
  return next(err);
}

module.exports = handleErr;
