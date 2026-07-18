'use strict';

const express = require('express');
const router = express.Router();

router.get('/', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders?.();
  res.write(': connected\n\n');

  const { sseClients } = req.app.locals;
  sseClients.add(res);

  // Keep the connection alive through proxies/idle timeouts.
  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch (_) {}
  }, 20000);

  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
  });
});

module.exports = router;
