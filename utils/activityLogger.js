const Activity = require('../models/Activity');

const logActivity = async ({ user, action, category, details, status = 'info' }) => {
    try {
        const activity = new Activity({
            user,
            action,
            category,
            details,
            status
        });
        await activity.save();
    } catch (err) {
        console.error('Error logging activity:', err);
    }
};

module.exports = logActivity;
