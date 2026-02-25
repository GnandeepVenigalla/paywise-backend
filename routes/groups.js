const express = require('express');
const router = express.Router();
const Group = require('../models/Group');
const Expense = require('../models/Expense');
const User = require('../models/User');
const auth = require('../middleware/auth');
const sendEmail = require('../utils/sendEmail');

// @route   POST api/groups
// @desc    Create a group
router.post('/', auth, async (req, res) => {
    try {
        const { name } = req.body;
        const members = req.body.members || [];
        // Include the creator in members
        const allMembers = [...new Set([...members, req.user.id])];

        const newGroup = new Group({
            name,
            members: allMembers,
            createdBy: req.user.id
        });

        const group = await newGroup.save();
        res.json(group);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   GET api/groups
// @desc    Get all groups for a user
router.get('/', auth, async (req, res) => {
    try {
        const groups = await Group.find({ members: req.user.id }).populate('members', 'username email');
        res.json(groups);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   GET api/groups/:id
// @desc    Get complete group details along with expenses and balances
router.get('/:id', auth, async (req, res) => {
    try {
        const group = await Group.findById(req.params.id).populate('members', 'username email');
        if (!group) return res.status(404).json({ msg: 'Group not found' });

        // Ensure user is part of group
        if (!group.members.some(member => member._id.toString() === req.user.id)) {
            return res.status(401).json({ msg: 'Not authorized' });
        }

        const expenses = await Expense.find({ group: req.params.id }).populate('paidBy', 'username email').sort({ date: -1 });

        // Calculate balances dynamically
        let balances = {}; // { userId: balance }
        group.members.forEach(m => { balances[m._id.toString()] = 0; });

        expenses.forEach(exp => {
            if (balances[exp.paidBy._id.toString()] !== undefined) {
                balances[exp.paidBy._id.toString()] += exp.amount;
            }

            exp.splits.forEach(split => {
                if (balances[split.user.toString()] !== undefined) {
                    balances[split.user.toString()] -= split.amount;
                }
            });
        });

        res.json({ group, expenses, balances });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   POST api/groups/:id/members
// @desc    Add member to group via email
router.post('/:id/members', auth, async (req, res) => {
    try {
        const { email } = req.body;
        const group = await Group.findById(req.params.id);

        if (!group) return res.status(404).json({ msg: 'Group not found' });

        const user = await User.findOne({ email });

        // If user is not yet registered, send an email invite!
        if (!user) {
            await sendEmail({
                email,
                subject: `You're invited to join ${group.name} on Paywise!`,
                message: `Hi there!\n\nYou've been invited to join the group "${group.name}" on Paywise to easily track and split expenses.\n\nSign up here to join: http://localhost:5173/register\n\nWelcome to Paywise!`
            });
            return res.json({ msg: 'Invitation email sent!' });
        }

        if (!group.members.includes(user._id)) {
            group.members.push(user._id);
            await group.save();
        }
        res.json({ msg: 'User added to your group successfully!', group });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

module.exports = router;
