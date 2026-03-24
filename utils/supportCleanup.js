const nodeCron = require('node-cron');
const Support = require('../models/Support');

/**
 * Automagic Cleanup Protocol for Closed Support Tickets
 * Runs daily at midnight to purge resolved data from the system (1 week cycle)
 */
const startSupportCleanup = () => {
    // Schedule to run every day at midnight (00:00)
    nodeCron.schedule('0 0 * * *', async () => {
        try {
            const ONE_WEEK_AGO = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
            
            console.log('[Paywise/Cleanup] Initiating 7-day protocol for closed tickets...');
            
            // Delete tickets fixed in status 'closed' and closed more than 7 days ago
            const result = await Support.deleteMany({
                status: 'closed',
                closedAt: { $lte: ONE_WEEK_AGO }
            });

            if (result.deletedCount > 0) {
                console.log(`[Paywise/Cleanup] Successfully purged ${result.deletedCount} resolved tickets safely.`);
            }
        } catch (err) {
            console.error('[Paywise/Cleanup] System error during support purge:', err);
        }
    });

    console.log('[Paywise/Cleanup] Support ticket auto-removal protocol initialized (7-day lifecycle).');
};

module.exports = startSupportCleanup;
