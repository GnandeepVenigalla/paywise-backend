const express = require('express');
const router = express.Router();
const Group = require('../models/Group');
const Expense = require('../models/Expense');
const User = require('../models/User');
const auth = require('../middleware/auth');
const sendEmail = require('../utils/sendEmail');
const logActivity = require('../utils/activityLogger');

// @route   POST api/groups
// @desc    Create a group
router.post('/', auth, async (req, res) => {
    try {
        const { name, groupType } = req.body;
        const members = req.body.members || [];
        // Include the creator in members
        const allMembers = [...new Set([...members, req.user.id])];

        const newGroup = new Group({
            name,
            members: allMembers,
            createdBy: req.user.id,
            groupType: groupType || 'default',
            paymentCycle: groupType === 'community' 
                ? allMembers.map(mId => ({ user: mId, hasPaid: false }))
                : []
        });

        const group = await newGroup.save();
        
        await logActivity({
            user: req.user.id,
            action: `New ${groupType || 'default'} group initialized: "${name}"`,
            category: 'group',
            status: 'success'
        });

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
        const group = await Group.findById(req.params.id)
            .populate('members pastMembers', 'username email')
            .populate('paymentCycle.user', 'username email');
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
// @desc    Add member to group via email. Creates ghost users if they don't exist.
router.post('/:id/members', auth, async (req, res) => {
    try {
        const { email, phone } = req.body;
        if (!email && !phone) return res.status(400).json({ msg: 'Please provide email or phone number' });

        const group = await Group.findById(req.params.id);
        if (!group) return res.status(404).json({ msg: 'Group not found' });

        // Security check: Must be a current member to add others
        if (!group.members.includes(req.user.id)) {
            return res.status(401).json({ msg: 'Not authorized' });
        }

        let user;
        let query;

        if (email) {
            query = { email: email.toLowerCase() };
            user = await User.findOne(query);
        } else if (phone) {
            const rawPhone = phone.replace(/\D/g, '');
            console.log(`[Paywise] Searching for phone: ${phone} (raw: ${rawPhone})`);
            
            // Try robust fuzzy lookup
            const phoneRegexStr = rawPhone.length > 0 ? rawPhone.split('').join('\\D*') : '^$';
            query = { phone: new RegExp(phoneRegexStr, 'i') };
            user = await User.findOne(query);

            if (!user && rawPhone.length >= 10) {
                // Fallback: search for last 10 digits only (ignoring country code if searcher didn't provide +1)
                const last10 = rawPhone.slice(-10);
                user = await User.findOne({ phone: new RegExp(last10.split('').join('\\D*'), 'i') });
            }
            
            console.log(`[Paywise] User found by phone? ${!!user}`);
        }

        // If user not found, CREATE a ghost account
        if (!user) {
            if (email) {
                // Generate a ghost username from the email or random string
                let baseUsername = email.split('@')[0].replace(/[^a-zA-Z0-9_]/g, '');
                let finalUsername = baseUsername;
                let counter = 1;
                while (await User.findOne({ username: finalUsername })) {
                    finalUsername = `${baseUsername}${counter++}`;
                }

                user = new User({
                    username: finalUsername,
                    email: email.toLowerCase(),
                    isGhostUser: true,
                    isVerified: false,
                    password: require('crypto').randomBytes(16).toString('hex') // unuseable password
                });
                await user.save();
            } else {
                // Ghost User via Phone
                const rawPhone = phone.replace(/\D/g, '');
                if (rawPhone.length < 5) return res.status(400).json({ msg: 'Please provide a valid phone number' });

                // Create a ghost user with a placeholder email since it's required
                // We use a formatted placeholder so we can find them later if they register via phone
                const placeholderEmail = `ghost_phone_${rawPhone}@paywise.local`;
                
                // Check if this ghost already exists (maybe they were added to another group first)
                user = await User.findOne({ 
                    $or: [
                        { email: placeholderEmail },
                        { phone: new RegExp(rawPhone.split('').join('\\D*'), 'i') }
                    ]
                });

                if (!user) {
                    user = new User({
                        username: `User_${rawPhone.slice(-4)}`,
                        email: placeholderEmail,
                        phone: rawPhone,
                        isGhostUser: true,
                        isVerified: false,
                        password: require('crypto').randomBytes(16).toString('hex')
                    });
                    await user.save();
                }
            }
        }

        const currentUser = await User.findById(req.user.id);
        if (user.blockedUsers.includes(req.user.id) || (currentUser.blockedUsers && currentUser.blockedUsers.includes(user._id))) {
            return res.status(403).json({ msg: 'Cannot add a blocked user to a group.' });
        }

        // Check if already in group
        if (group.members.includes(user._id)) {
            return res.status(400).json({ msg: 'User is already in this group' });
        }

        // Add to group
        group.pastMembers = group.pastMembers.filter(id => id.toString() !== user._id.toString());
        group.members.push(user._id);
        
        // Use pendingMembers if user is real (requires acceptance)
        if (!user.isGhostUser && user._id.toString() !== req.user.id) {
            if (!group.pendingMembers) group.pendingMembers = [];
            if (!group.pendingMembers.includes(user._id)) {
                group.pendingMembers.push(user._id);
            }
        }

        if (group.groupType === 'community') {
            group.paymentCycle.push({ user: user._id, hasPaid: false });
        }
        await group.save();

        // ── Notifications and Emails ────────────────────────────
        const { createNotification } = require('../utils/notificationService');
        const baseUrl = process.env.FRONTEND_URL || 'https://www.paywiseapp.com/#';
        
        if (user.isGhostUser) {
            // Send registration email for ghost users
            await sendEmail({
                email: user.email,
                subject: `You've been added to ${group.name} on Paywise!`,
                message: `Hi there!\n\n${currentUser.username} added you to the group "${group.name}" on Paywise to easily track and split expenses.\n\nYou are NOT currently registered, but your expenses are already being recorded! Sign up with this email to view your balances and join the group.\n\nSign up here: ${baseUrl}/register\n\nWelcome to Paywise!`
            }).catch(e => console.error('Invite email fail:', e.message));
        } else {
            // Send in-app notification and invite email for real users
            await createNotification({
                recipientId: user._id,
                title: `Group Invite: ${group.name}`,
                message: `${currentUser.username} invited you to join the group "${group.name}".`,
                category: 'group',
                actionUrl: `/group/${group._id}` 
            }).catch(e => console.error('In-app notification fail:', e.message));

            await sendEmail({
                email: user.email,
                subject: `Invitation to join ${group.name} on Paywise`,
                message: `Hi ${user.username}!\n\n${currentUser.username} added you to their group "${group.name}" on Paywise.\n\nLog in now to see the group: ${baseUrl}/dashboard\n\nSee you there!`
            }).catch(e => console.error('Existing user email fail:', e.message));
        }

        res.json({ msg: user.isGhostUser ? 'New user invited and added to group!' : 'User added to group!', group, user });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   POST api/groups/:id/accept
// @desc    Accept a group invitation
router.post('/:id/accept', auth, async (req, res) => {
    try {
        const group = await Group.findById(req.params.id);
        if (!group) return res.status(404).json({ msg: 'Group not found' });

        if (!group.members.includes(req.user.id)) {
            return res.status(400).json({ msg: 'You are not invited to this group' });
        }

        // Remove from pending if it exists
        if (group.pendingMembers) {
            group.pendingMembers = group.pendingMembers.filter(id => id.toString() !== req.user.id);
        }

        await group.save();
        res.json({ msg: 'Invitation accepted!', group });
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

        // Remove from payment cycle if community
        if (group.groupType === 'community') {
            group.paymentCycle = group.paymentCycle.filter(item => item.user.toString() !== req.user.id);
        }

        await group.save();
        res.json({ msg: 'Successfully left the group', group });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   POST api/groups/:id/remove/:userId
// @desc    Remove an active member from a group (can be done by anyone in the group)
router.post('/:id/remove/:userId', auth, async (req, res) => {
    try {
        const group = await Group.findById(req.params.id);
        if (!group) return res.status(404).json({ msg: 'Group not found' });

        if (!group.members.includes(req.user.id)) {
            return res.status(400).json({ msg: 'You are not an active member of this group' });
        }

        const targetUserId = req.params.userId;
        if (!group.members.includes(targetUserId)) {
            return res.status(400).json({ msg: 'User is not an active member' });
        }

        const expenses = await Expense.find({ group: req.params.id });
        let userBalance = 0;

        const { convertAmount } = require('../utils/currency');
        expenses.forEach(exp => {
            const sourceCurr = exp.currency || 'USD';
            if (exp.paidBy.toString() === targetUserId) {
                userBalance += convertAmount(exp.amount, sourceCurr, 'USD');
            }
            exp.splits.forEach(split => {
                if (split.user.toString() === targetUserId) {
                    userBalance -= convertAmount(split.amount, sourceCurr, 'USD');
                }
            });
        });

        group.members = group.members.filter(id => id.toString() !== targetUserId);

        if (Math.abs(userBalance) > 0.01) {
            if (!group.pastMembers.includes(targetUserId)) {
                group.pastMembers.push(targetUserId);
            }
        }

        // Remove from payment cycle if community
        if (group.groupType === 'community') {
            group.paymentCycle = group.paymentCycle.filter(item => item.user.toString() !== targetUserId);
        }

        await group.save();
        res.json({ msg: 'Successfully removed member from group', group });
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
            if (group.groupType === 'community') {
                group.paymentCycle.push({ user: req.user.id, hasPaid: false });
            }
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
