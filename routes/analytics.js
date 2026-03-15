const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const trackMetric = require('../utils/analyticsTracker');

// @route   POST api/analytics/track
// @desc    Track a specific ad or system metric
// @access  Private (Authenticated)
router.post('/track', auth, async (req, res) => {
    const { type, value } = req.body;

    // Allowed metrics to prevent database pollution
    const allowedMetrics = ['adRequests', 'adImpressions', 'adClicks', 'visits', 'aiRequests'];

    if (!allowedMetrics.includes(type)) {
        return res.status(400).json({ msg: 'Invalid metric type' });
    }

    try {
        await trackMetric(type, value || 1);
        res.json({ success: true, type });
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
});

module.exports = router;
