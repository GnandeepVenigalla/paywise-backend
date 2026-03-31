const Notification = require('../models/Notification');
const User = require('../models/User');

/**
 * Creates an in-app notification for a user.
 * 
 * @param {Object} params
 * @param {string} params.recipientId - ID of the user receiving the notification
 * @param {string} params.title - Notification title
 * @param {string} params.message - Notification message
 * @param {string} [params.type='info'] - 'info', 'warning', 'error', 'success'
 * @param {string} [params.category='system'] - 'expense', 'loan', 'friend', 'system'
 * @param {string} [params.actionUrl] - Optional URL to link to
 * @param {Object} [params.metadata] - Optional extra data
 */
async function createNotification({
    recipientId,
    title,
    message,
    type = 'info',
    category = 'system',
    actionUrl = null,
    metadata = {}
}) {
    try {
        const notification = new Notification({
            recipient: recipientId,
            title,
            message,
            type,
            category,
            actionUrl,
            metadata
        });
        await notification.save();
        return notification;
    } catch (err) {
        console.error('[NotificationService] Error creating notification:', err.message);
        return null;
    }
}

/**
 * Notify multiple users at once.
 */
async function notifyMany({
    recipientIds,
    title,
    message,
    type = 'info',
    category = 'system',
    actionUrl = null,
    metadata = {}
}) {
    try {
        const notifications = recipientIds.map(id => ({
            recipient: id,
            title,
            message,
            type,
            category,
            actionUrl,
            metadata
        }));
        await Notification.insertMany(notifications);
    } catch (err) {
        console.error('[NotificationService] Error notifying many users:', err.message);
    }
}

module.exports = {
    createNotification,
    notifyMany
};
