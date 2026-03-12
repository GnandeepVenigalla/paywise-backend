const Analytics = require('../models/Analytics');

const trackMetric = async (type, value = 1) => {
    try {
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const update = {};
        update[type] = value;

        await Analytics.findOneAndUpdate(
            { date: today },
            { $inc: update },
            { upsert: true, new: true }
        );
    } catch (err) {
        console.error('Error tracking metric:', err);
    }
};

module.exports = trackMetric;
