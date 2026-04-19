const express = require('express');
const { z } = require('zod');
const { authMiddleware, requireFeature } = require('../middleware/auth');
const optService = require('../services/optimizationService');
const validation = require('../utils/validation');
const optimizer = require('../services/optimizer');

const router = express.Router();

function handleErr(err, res, next) {
  if (err instanceof z.ZodError) {
    return res.status(400).json({
      error: 'Validation failed', code: 'VALIDATION_ERROR',
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
  return next(err);
}

// Param spec validator — each key maps to an int/float/choice spec
const paramSpecSchema = z.union([
  z.object({
    type: z.literal('int'),
    min: z.number().int(),
    max: z.number().int(),
    step: z.number().int().positive().optional(),
  }),
  z.object({
    type: z.literal('float'),
    min: z.number(),
    max: z.number(),
    step: z.number().positive().optional(),
  }),
  z.object({
    type: z.literal('choice'),
    choices: z.array(z.union([z.string(), z.number(), z.boolean()])).min(1),
  }),
]);

const createSchema = z.object({
  baseConfig: validation.createBacktestSchema,
  paramSpace: z.record(paramSpecSchema).refine((o) => Object.keys(o).length > 0, 'paramSpace must have at least one param'),
  objective: z.enum(optimizer.OBJECTIVES).default('profitFactor'),
  nTrials: z.number().int().min(1).max(100).default(20),
});

// POST /api/optimizations — create + queue
router.post('/', authMiddleware, requireFeature('optimizer'), (req, res, next) => {
  try {
    const input = createSchema.parse(req.body);
    const opt = optService.createOptimization(req.userId, input);
    res.status(201).json(opt);
  } catch (err) { handleErr(err, res, next); }
});

// GET /api/optimizations — list
router.get('/', authMiddleware, requireFeature('optimizer'), (req, res, next) => {
  try {
    const q = z.object({
      limit: z.coerce.number().int().min(1).max(100).default(50),
      offset: z.coerce.number().int().min(0).default(0),
    }).parse(req.query);
    const list = optService.listForUser(req.userId, q);
    res.json({ count: list.length, optimizations: list });
  } catch (err) { handleErr(err, res, next); }
});

// GET /api/optimizations/:id
router.get('/:id', authMiddleware, requireFeature('optimizer'), (req, res, next) => {
  try {
    const id = z.coerce.number().int().positive().parse(req.params.id);
    const opt = optService.getOptimization(id, req.userId);
    if (!opt) return res.status(404).json({ error: 'Optimization not found' });
    res.json(opt);
  } catch (err) { handleErr(err, res, next); }
});

// DELETE /api/optimizations/:id
router.delete('/:id', authMiddleware, requireFeature('optimizer'), (req, res, next) => {
  try {
    const id = z.coerce.number().int().positive().parse(req.params.id);
    res.json(optService.deleteOptimization(id, req.userId));
  } catch (err) { handleErr(err, res, next); }
});

// GET /api/optimizations/meta/objectives — list supported objectives
router.get('/meta/objectives', (_req, res) => {
  res.json({ objectives: optimizer.OBJECTIVES });
});

module.exports = router;
