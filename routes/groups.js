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
        const groups = await Group.find({
            $or: [{ members: req.user.id }, { pastMembers: req.user.id }]
        }).populate('members pastMembers', 'username email');
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
        const group = await Group.findById(req.params.id).populate('members pastMembers', 'username email');
        if (!group) return res.status(404).json({ msg: 'Group not found' });

        // Ensure user is part of group (active or past)
        const isMember = group.members.some(member => member._id.toString() === req.user.id);
        const isPastMember = group.pastMembers.some(member => member._id.toString() === req.user.id);

        if (!isMember && !isPastMember) {
            return res.status(401).json({ msg: 'Not authorized' });
        }

        const expenses = await Expense.find({ group: req.params.id }).populate('paidBy', 'username email').sort({ date: -1 });

        // Calculate balances dynamically for ALL members (active and past)
        let balances = {}; // { userId: balance }
        const allAssociatedMembers = [...group.members, ...group.pastMembers];
        allAssociatedMembers.forEach(m => { balances[m._id.toString()] = 0; });

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
            const baseUrl = process.env.FRONTEND_URL || 'https://gnandeepvenigalla.github.io/Paywise/#';
            await sendEmail({
                email,
                subject: `You're invited to join ${group.name} on Paywise!`,
                message: `Hi there!\n\nYou've been invited to join the group "${group.name}" on Paywise to easily track and split expenses.\n\nSign up here to join: ${baseUrl}/register\n\nWelcome to Paywise!`
            });
            return res.json({ msg: 'Invitation email sent!' });
        }

        if (!group.members.includes(user._id)) {
            // Remove from pastMembers if re-joining
            group.pastMembers = group.pastMembers.filter(id => id.toString() !== user._id.toString());
            group.members.push(user._id);
            await group.save();
        }
        res.json({ msg: 'User added to your group successfully!', group });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   PUT api/groups/:id
// @desc    Edit group name
router.put('/:id', auth, async (req, res) => {
    try {
        const { name } = req.body;
        const group = await Group.findById(req.params.id);

        if (!group) return res.status(404).json({ msg: 'Group not found' });

        // Must be a current member to edit
        if (!group.members.includes(req.user.id)) {
            return res.status(401).json({ msg: 'Not authorized' });
        }

        group.name = name;
        await group.save();
        res.json(group);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   POST api/groups/:id/leave
// @desc    Leave a group
router.post('/:id/leave', auth, async (req, res) => {
    try {
        const group = await Group.findById(req.params.id);
        if (!group) return res.status(404).json({ msg: 'Group not found' });

        if (!group.members.includes(req.user.id)) {
            return res.status(400).json({ msg: 'You are not an active member of this group' });
        }

        // Calculate user balance
        const expenses = await Expense.find({ group: req.params.id });
        let userBalance = 0;

        expenses.forEach(exp => {
            if (exp.paidBy.toString() === req.user.id) {
                userBalance += exp.amount;
            }
            exp.splits.forEach(split => {
                if (split.user.toString() === req.user.id) {
                    userBalance -= split.amount;
                }
            });
        });

        // Remove from members
        group.members = group.members.filter(id => id.toString() !== req.user.id);

        // If absolute balance is greater than 0.01 (handling floating points), move to pastMembers
        if (Math.abs(userBalance) > 0.01) {
            if (!group.pastMembers.includes(req.user.id)) {
                group.pastMembers.push(req.user.id);
            }
        }

        await group.save();
        res.json({ msg: 'Successfully left the group', group });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

module.exports = router;
