const authService = require('../services/authService');

/**
 * JWT authentication middleware.
 * Extracts the Bearer token from the Authorization header,
 * verifies it, and attaches userId + email to req.
 */
function authMiddleware(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Authentication token required' });
    }

    const token = authHeader.split(' ')[1];
    const decoded = authService.verifyToken(token);
    req.userId = decoded.userId;
    req.userEmail = decoded.email;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

/**
 * Subscription tier check middleware factory.
 * Returns middleware that verifies the user has at least the required tier.
 *
 * Tier hierarchy: free < starter < pro < elite < enterprise
 */
function requireTier(minimumTier) {
  const tierOrder = ['free', 'starter', 'pro', 'elite', 'enterprise'];

  return (req, res, next) => {
    try {
      // Lazy-load to avoid circular dependency at module-load time
      const subscriptionService = require('../services/subscriptionService');
      const sub = subscriptionService.getUserSubscription(req.userId);
      const userTier = sub ? sub.plan : 'free';
      const userLevel = tierOrder.indexOf(userTier);
      const requiredLevel = tierOrder.indexOf(minimumTier);

      if (userLevel < requiredLevel) {
        return res.status(403).json({
          error: `This feature requires "${minimumTier}" plan or higher`,
          currentPlan: userTier,
          requiredPlan: minimumTier,
        });
      }

      req.userPlan = userTier;
      next();
    } catch (error) {
      return res.status(500).json({ error: 'Failed to verify subscription' });
    }
  };
}

module.exports = { authMiddleware, requireTier };
