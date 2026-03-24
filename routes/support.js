const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const Support = require('../models/Support');

// @route   POST api/support
// @desc    Submit a new support ticket
router.post('/', auth, async (req, res) => {
    try {
        const { subject, message, priority } = req.body;

        const newTicket = new Support({
            user: req.user.id,
            subject,
            message,
            priority: priority || 'medium'
        });

        await newTicket.save();
        res.json(newTicket);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   GET api/support
// @desc    Get user's support tickets
router.get('/', auth, async (req, res) => {
    try {
        const tickets = await Support.find({ user: req.user.id }).sort({ createdAt: -1 });
        res.json(tickets);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   POST api/support/:id/reply
// @desc    User replies to a ticket
router.post('/:id/reply', auth, async (req, res) => {
    try {
        const { message } = req.body;
        const ticket = await Support.findById(req.params.id);

        if (!ticket) return res.status(404).json({ msg: 'Ticket not found' });
        // Unauthorized if user is not the ticket owner AND not an admin
        // Root users are handled later but for now check role or simplify
        if (ticket.user.toString() !== req.user.id) return res.status(401).json({ msg: 'Unauthorized' });

        ticket.replies.push({
            sender: req.user.id,
            message,
            isAdmin: false
        });

        // Set status back to 'open' if it was progress
        if (ticket.status === 'closed') ticket.status = 'in-progress';

        await ticket.save();
        res.json(ticket);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// Admin routes can be added to admin.js instead or here with isAdmin middleware.
// For now let's keep it simple.

module.exports = router;
