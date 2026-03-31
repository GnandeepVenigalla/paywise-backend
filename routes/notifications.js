const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const Notification = require('../models/Notification');

// @route   GET api/notifications
// @desc    Get user's notifications
router.get('/', auth, async (req, res) => {
    try {
        const notifications = await Notification.find({
            $or: [
                { recipient: req.user.id },
                { targetRole: 'all' }
            ]
        }).sort({ createdAt: -1 }).limit(50);
        res.json(notifications);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   PUT api/notifications/read-all
// @desc    Mark all user's notifications as read
router.put('/read-all', auth, async (req, res) => {
    try {
        await Notification.updateMany(
            { recipient: req.user.id, isRead: false },
            { $set: { isRead: true } }
        );
        res.json({ msg: 'All notifications marked as read' });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   PUT api/notifications/:id/read
// @desc    Mark a notification as read
router.put('/:id/read', auth, async (req, res) => {
    try {
        const notification = await Notification.findById(req.params.id);
        if (!notification) return res.status(404).json({ msg: 'Notification not found' });

        // Security: Ensure the notification belongs to the user or is a general one
        if (notification.recipient && notification.recipient.toString() !== req.user.id) {
            return res.status(401).json({ msg: 'User not authorized' });
        }

        notification.isRead = true;
        await notification.save();
        res.json(notification);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   DELETE api/notifications/:id
// @desc    Delete a notification
router.delete('/:id', auth, async (req, res) => {
    try {
        const notification = await Notification.findById(req.params.id);
        if (!notification) return res.status(404).json({ msg: 'Notification not found' });

        if (notification.recipient && notification.recipient.toString() !== req.user.id) {
            return res.status(401).json({ msg: 'User not authorized' });
        }

        await Notification.deleteOne({ _id: req.params.id });
        res.json({ msg: 'Notification removed' });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

module.exports = router;
