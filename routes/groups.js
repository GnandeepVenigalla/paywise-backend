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

        // Fetch the user to get their block list
        const currentUser = await User.findById(req.user.id);
        const blockedUserIds = (currentUser.blockedUsers || []).map(id => id.toString());

        // Calculate balances dynamically for each group
        const groupsWithBalances = await Promise.all(groups.map(async (group) => {
            const expenses = await Expense.find({ group: group._id });

            let balances = {};
            group.members.forEach(m => { balances[m._id.toString()] = 0; });
            group.pastMembers.forEach(m => { balances[m._id.toString()] = 0; });

            const { convertAmount } = require('../utils/currency');
            expenses.forEach(exp => {
                const payerId = exp.paidBy.toString();
                const sourceCurr = exp.currency || 'USD';
                if (balances[payerId] !== undefined) {
                    balances[payerId] += convertAmount(exp.amount, sourceCurr, 'USD');
                }
                exp.splits.forEach(split => {
                    const userId = split.user.toString();
                    if (balances[userId] !== undefined) {
                        balances[userId] -= convertAmount(split.amount, sourceCurr, 'USD');
                    }
                });
            });

            // Convert to a plain object and add balances
            const groupObj = group.toObject();
            groupObj.balances = balances;
            return groupObj;
        }));

        // Hide groups that contain any blocked users
        const filteredGroups = groupsWithBalances.filter(group => {
            const groupMemberIds = group.members.map(m => (m._id || m).toString());
            return !groupMemberIds.some(id => blockedUserIds.includes(id));
        });

        res.json(filteredGroups);
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

        const expenses = await Expense.find({ group: req.params.id })
            .populate('paidBy', 'username email')
            .populate('addedBy', 'username email')
            .populate('splits.user', 'username email')
            .populate('items.assignedTo', 'username email')
            .sort({ date: -1 });

        // Calculate balances dynamically for ALL members (active and past)
        let balances = {}; // { userId: balance }
        const allAssociatedMembers = [...group.members, ...group.pastMembers];
        allAssociatedMembers.forEach(m => { balances[m._id.toString()] = 0; });

        const { convertAmount } = require('../utils/currency');
        expenses.forEach(exp => {
            const payerId = exp.paidBy._id.toString();
            const sourceCurr = exp.currency || 'USD';
            if (balances[payerId] !== undefined) {
                balances[payerId] += convertAmount(exp.amount, sourceCurr, 'USD');
            }

            exp.splits.forEach(split => {
                const debtorId = split.user._id ? split.user._id.toString() : split.user.toString();
                if (balances[debtorId] !== undefined) {
                    balances[debtorId] -= convertAmount(split.amount, sourceCurr, 'USD');
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
        const { email, phone } = req.body;
        const group = await Group.findById(req.params.id);

        if (!group) return res.status(404).json({ msg: 'Group not found' });

        const query = email ? { email } : { phone };
        const user = await User.findOne(query);

        // Fetch the current user to check block list
        const currentUser = await User.findById(req.user.id);

        if (user && (user.blockedUsers.includes(req.user.id) || (currentUser.blockedUsers && currentUser.blockedUsers.includes(user._id)))) {
            return res.status(403).json({ msg: 'Cannot add a blocked user to a group.' });
        }

        // If user is not yet registered or is a ghost account, send an email invite!
        if (!user || user.isGhostUser) {
            if (email) {
                const baseUrl = process.env.FRONTEND_URL || 'https://www.paywiseapp.com/#';
                await sendEmail({
                    email,
                    subject: `You're invited to join ${group.name} on Paywise!`,
                    message: `Hi there!\n\nYou've been invited to join the group "${group.name}" on Paywise to easily track and split expenses.\n\nSign up here to join: ${baseUrl}/register\n\nWelcome to Paywise!`
                });

                // If user exists as a ghost, still add them to the group so balances start tracking
                if (user) {
                    if (!group.members.includes(user._id)) {
                        group.members.push(user._id);
                        await group.save();
                    }
                    return res.json({ msg: 'Invitation email sent to ghost user!' });
                }

                return res.json({ msg: 'Invitation email sent!' });
            } else {
                // If they searched by phone and no user found, we can't send an email
                return res.status(404).json({ msg: 'No user found with this phone number. Ask them to register first or invite them by email.' });
            }
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
        const { name, currency } = req.body;
        const group = await Group.findById(req.params.id);

        if (!group) return res.status(404).json({ msg: 'Group not found' });

        // Must be a current member to edit
        if (!group.members.includes(req.user.id)) {
            return res.status(401).json({ msg: 'Not authorized' });
        }

        if (name) group.name = name;
        if (currency !== undefined) group.currency = currency;
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

        const { convertAmount } = require('../utils/currency');
        expenses.forEach(exp => {
            const sourceCurr = exp.currency || 'USD';
            if (exp.paidBy.toString() === req.user.id) {
                userBalance += convertAmount(exp.amount, sourceCurr, 'USD');
            }
            exp.splits.forEach(split => {
                if (split.user.toString() === req.user.id) {
                    userBalance -= convertAmount(split.amount, sourceCurr, 'USD');
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

// @route   POST api/groups/:id/join
// @desc    Join a group via link
router.post('/:id/join', auth, async (req, res) => {
    try {
        const group = await Group.findById(req.params.id);
        if (!group) return res.status(404).json({ msg: 'Group not found' });

        if (!group.members.includes(req.user.id)) {
            // Remove from pastMembers if re-joining
            group.pastMembers = group.pastMembers.filter(id => id.toString() !== req.user.id.toString());
            group.members.push(req.user.id);
            await group.save();
        }
        res.json({ msg: 'Joined group successfully!', group });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   PUT api/groups/:id/note
// @desc    Update a group's shared note (visible to all members)
router.put('/:id/note', auth, async (req, res) => {
    try {
        const group = await Group.findById(req.params.id);
        if (!group) return res.status(404).json({ msg: 'Group not found' });

        const isMember = group.members.map(m => m.toString()).includes(req.user.id) ||
            group.pastMembers.map(m => m.toString()).includes(req.user.id);
        if (!isMember) return res.status(403).json({ msg: 'Not authorized' });

        group.note = req.body.note || '';
        await group.save();
        res.json({ note: group.note });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   PUT api/groups/:id/settle-date
// @desc    Set or clear the group's settle-up date
router.put('/:id/settle-date', auth, async (req, res) => {
    try {
        const group = await Group.findById(req.params.id);
        if (!group) return res.status(404).json({ msg: 'Group not found' });

        const isMember = group.members.map(m => m.toString()).includes(req.user.id) ||
            group.pastMembers.map(m => m.toString()).includes(req.user.id);
        if (!isMember) return res.status(403).json({ msg: 'Not authorized' });

        group.settleUpDate = req.body.settleUpDate ? new Date(req.body.settleUpDate) : null;
        await group.save();
        res.json({ settleUpDate: group.settleUpDate });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   DELETE api/groups/:id
// @desc    Delete a group and all its expenses (creator only)
router.delete('/:id', auth, async (req, res) => {
    try {
        const group = await Group.findById(req.params.id);
        if (!group) return res.status(404).json({ msg: 'Group not found' });

        // Only the creator can delete the group
        if (group.createdBy.toString() !== req.user.id) {
            return res.status(403).json({ msg: 'Only the group creator can delete this group' });
        }

        // Delete all expenses belonging to this group
        await Expense.deleteMany({ group: group._id });

        // Delete the group
        await Group.findByIdAndDelete(group._id);

        res.json({ msg: 'Group and all its expenses deleted successfully' });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

module.exports = router;
