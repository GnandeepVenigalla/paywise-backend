const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const User = require('../models/User');
const auth = require('../middleware/auth');
const sendEmail = require('../utils/sendEmail');

// @route   POST api/auth/register
// @desc    Register user (promotes ghost accounts from Splitwise migration)
router.post('/register', async (req, res) => {
    const { username, email, password } = req.body;
    try {
        let user = await User.findOne({ email });
        if (user) {
            if (user.isGhostUser) {
                // Promote ghost account — keep all their existing expense/group/friend data
                const salt = await bcrypt.genSalt(10);
                user.password = await bcrypt.hash(password, salt);
                user.username = username;
                user.isGhostUser = false;
                user.splitwiseMigrationStatus = 'none'; // so they can also migrate their own data
                await user.save();
                const payload = { user: { id: user.id } };
                return jwt.sign(payload, process.env.JWT_SECRET || 'secret', { expiresIn: 360000 }, (err, token) => {
                    if (err) throw err;
                    res.json({ token, user: { id: user.id, username: user.username, email: user.email } });
                });
            }
            return res.status(400).json({ msg: 'User already exists' });
        }

        user = new User({ username, email, password });
        const salt = await bcrypt.genSalt(10);
        user.password = await bcrypt.hash(password, salt);
        await user.save();

        const payload = { user: { id: user.id } };
        jwt.sign(payload, process.env.JWT_SECRET || 'secret', { expiresIn: 360000 }, (err, token) => {
            if (err) throw err;
            res.json({ token, user: { id: user.id, username: user.username, email: user.email } });
        });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server error');
    }
});

// @route   POST api/auth/login
// @desc    Authenticate user & get token
router.post('/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        let user = await User.findOne({ email });
        if (!user) {
            return res.status(400).json({ msg: 'Invalid Credentials' });
        }

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.status(400).json({ msg: 'Invalid Credentials' });
        }

        const payload = { user: { id: user.id } };
        jwt.sign(payload, process.env.JWT_SECRET || 'secret', { expiresIn: 360000 }, (err, token) => {
            if (err) throw err;
            res.json({ token, user: { id: user.id, username: user.username, email: user.email } });
        });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server error');
    }
});

// @route   GET api/auth/me
// @desc    Get current user
router.get('/me', auth, async (req, res) => {
    try {
        const user = await User.findById(req.user.id).select('-password');
        // Map _id to id so frontend operations using user.id work correctly everywhere
        res.json({ ...user._doc, id: user._id });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server error');
    }
});

// @route   GET api/auth/users
// @desc    Search users by email
router.get('/users', auth, async (req, res) => {
    try {
        const users = await User.find({ email: new RegExp(req.query.q, 'i') }).select('-password');
        res.json(users);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server error');
    }
});

// @route   POST api/auth/forgotpassword
// @desc    Send password reset email
router.post('/forgotpassword', async (req, res) => {
    try {
        const user = await User.findOne({ email: req.body.email });
        if (!user) {
            return res.status(404).json({ msg: 'There is no user with that email' });
        }

        // Generate token
        const resetToken = crypto.randomBytes(20).toString('hex');

        // Hash token and set to resetPasswordToken field
        user.resetPasswordToken = crypto.createHash('sha256').update(resetToken).digest('hex');

        // Set token expire time (10 minutes)
        user.resetPasswordExpire = Date.now() + 10 * 60 * 1000;
        await user.save();

        // Create reset url
        const baseUrl = process.env.FRONTEND_URL || 'https://gnandeepvenigalla.github.io/Paywise/#';
        const resetUrl = `${baseUrl}/resetpassword/${resetToken}`;

        const message = `You are receiving this email because you (or someone else) has requested the reset of a password. Please make a PUT request to: \n\n ${resetUrl}`;

        try {
            await sendEmail({
                email: user.email,
                subject: 'Paywise Password Reset Token',
                message
            });
            res.status(200).json({ msg: 'Email sent' });
        } catch (err) {
            user.resetPasswordToken = undefined;
            user.resetPasswordExpire = undefined;
            await user.save();
            return res.status(500).json({ msg: 'Email could not be sent' });
        }
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   PUT api/auth/resetpassword/:resettoken
// @desc    Reset password using token
router.put('/resetpassword/:resettoken', async (req, res) => {
    try {
        // Get hashed token
        const resetPasswordToken = crypto.createHash('sha256').update(req.params.resettoken).digest('hex');

        const user = await User.findOne({
            resetPasswordToken,
            resetPasswordExpire: { $gt: Date.now() }
        });

        if (!user) {
            return res.status(400).json({ msg: 'Invalid or expired token' });
        }

        // Set new password
        const salt = await bcrypt.genSalt(10);
        user.password = await bcrypt.hash(req.body.password, salt);

        // Clear reset tokens
        user.resetPasswordToken = undefined;
        user.resetPasswordExpire = undefined;
        await user.save();

        res.status(200).json({ msg: 'Password reset successful' });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   POST api/auth/invite
// @desc    Send a Paywise referral invite to an email
router.post('/invite', auth, async (req, res) => {
    try {
        const { email } = req.body;

        const existingUser = await User.findOne({ email });
        if (existingUser) {
            return res.status(400).json({ msg: 'This user already has a Paywise account!' });
        }

        const sender = await User.findById(req.user.id);

        const baseUrl = process.env.FRONTEND_URL || 'https://gnandeepvenigalla.github.io/Paywise/#';
        const message = `Hi there!\n\n${sender.username} has invited you to join Paywise.\n\nPaywise is the smartest way to split itemized bills and track group expenses along with your friends.\n\nSign up today to join them: ${baseUrl}/register\n\nWelcome to Paywise!`;

        await sendEmail({
            email,
            subject: `${sender.username} invited you to Paywise!`,
            message
        });

        res.status(200).json({ msg: 'Invitation email sent successfully!' });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   GET api/auth/friends
// @desc    Get user's friends with their balances
router.get('/friends', auth, async (req, res) => {
    try {
        const user = await User.findById(req.user.id).populate('friends', 'username email');

        // Let's also compute the balance between the user and each friend
        // For each friend, find expenses where group is null and either user or friend paid, and the other is in splits
        const Expense = require('../models/Expense');

        const friendsWithBalances = await Promise.all(user.friends.map(async (friend) => {
            const expenses = await Expense.find({
                $or: [
                    { paidBy: user._id, 'splits.user': friend._id },
                    { paidBy: friend._id, 'splits.user': user._id }
                ]
            });

            let balance = 0; // Negative means user owes friend, Positive means friend owes user

            expenses.forEach(exp => {
                const isPaidByMe = exp.paidBy.toString() === user._id.toString();
                if (isPaidByMe) {
                    const friendSplit = exp.splits.find(s => s.user.toString() === friend._id.toString());
                    if (friendSplit) {
                        balance += friendSplit.amount; // Friend owes me
                    }
                } else {
                    const mySplit = exp.splits.find(s => s.user.toString() === user._id.toString());
                    if (mySplit) {
                        balance -= mySplit.amount; // I owe friend
                    }
                }
            });

            return {
                _id: friend._id,
                id: friend._id, // map for frontend
                username: friend.username,
                email: friend.email,
                balance
            };
        }));

        res.json(friendsWithBalances);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   POST api/auth/friends
// @desc    Add a friend
router.post('/friends', auth, async (req, res) => {
    try {
        const { friendId } = req.body;
        if (friendId === req.user.id) {
            return res.status(400).json({ msg: "You can't add yourself as a friend." });
        }

        const user = await User.findById(req.user.id);
        const friend = await User.findById(friendId);

        if (!friend) {
            return res.status(404).json({ msg: 'User not found' });
        }

        if (user.friends.includes(friendId)) {
            return res.status(400).json({ msg: 'User is already your friend' });
        }

        user.friends.push(friendId);
        friend.friends.push(user._id); // reciprocal friend

        await user.save();
        await friend.save();

        res.json({ msg: 'Friend added successfully' });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   PUT api/auth/notifications
// @desc    Update notification settings
router.put('/notifications', auth, async (req, res) => {
    try {
        const user = await User.findById(req.user.id);
        if (!user) return res.status(404).json({ msg: 'User not found' });

        user.notificationSettings = {
            ...user.notificationSettings,
            ...req.body
        };

        await user.save();
        res.json(user.notificationSettings);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   PUT api/auth/preferences
// @desc    Update user preferences (currency, timezone)
router.put('/preferences', auth, async (req, res) => {
    try {
        const user = await User.findById(req.user.id);
        if (!user) return res.status(404).json({ msg: 'User not found' });

        if (req.body.defaultCurrency) user.defaultCurrency = req.body.defaultCurrency;
        if (req.body.timezone) user.timezone = req.body.timezone;

        await user.save();
        res.json({ defaultCurrency: user.defaultCurrency, timezone: user.timezone });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   PUT api/auth/app-settings
// @desc    Save all app settings (split method, budget, theme, etc.)
router.put('/app-settings', auth, async (req, res) => {
    try {
        const user = await User.findById(req.user.id);
        if (!user) return res.status(404).json({ msg: 'User not found' });

        user.appSettings = {
            ...user.appSettings,
            ...req.body,
        };

        await user.save();
        res.json(user.appSettings);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   GET api/auth/friend-note/:friendId
// @desc    Get the shared note between two friends (stored on both sides)
router.get('/friend-note/:friendId', auth, async (req, res) => {
    try {
        const user = await User.findById(req.user.id);
        if (!user) return res.status(404).json({ msg: 'User not found' });
        const entry = user.friendNotes.find(n => n.friend.toString() === req.params.friendId);
        res.json({ note: entry ? entry.note : '' });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   PUT api/auth/friend-note/:friendId
// @desc    Save/update the shared note for a friend (stored on both users)
router.put('/friend-note/:friendId', auth, async (req, res) => {
    try {
        const noteText = req.body.note || '';

        // Update on the current user's side
        const user = await User.findById(req.user.id);
        let entry = user.friendNotes.find(n => n.friend.toString() === req.params.friendId);
        if (entry) {
            entry.note = noteText;
        } else {
            user.friendNotes.push({ friend: req.params.friendId, note: noteText });
        }
        await user.save();

        // Mirror on the friend's side so they see it too
        const friend = await User.findById(req.params.friendId);
        if (friend) {
            let friendEntry = friend.friendNotes.find(n => n.friend.toString() === req.user.id);
            if (friendEntry) {
                friendEntry.note = noteText;
            } else {
                friend.friendNotes.push({ friend: req.user.id, note: noteText });
            }
            await friend.save();
        }

        res.json({ note: noteText });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

module.exports = router;
