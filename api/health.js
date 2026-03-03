// ============================================================
// HEALTH CHECK — Simple endpoint to verify deployment
// ============================================================
module.exports = async function handler(req, res) {
  res.status(200).json({
    status: 'ok',
    bot: 'Meeting Tasks Bot',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
  });
};
