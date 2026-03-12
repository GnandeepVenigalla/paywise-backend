const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const User = require('../models/User');
const Report = require('../models/Report');
const auth = require('../middleware/auth');
const sendEmail = require('../utils/sendEmail');
const logActivity = require('../utils/activityLogger');

// @route   POST api/auth/register
// @desc    Register user (promotes ghost accounts from Splitwise migration)
router.post('/register', async (req, res) => {
    let { username, email, phone, password, defaultCurrency } = req.body;
    if (email) email = email.toLowerCase();
    if (!username || !email || !phone || !password) {
        return res.status(400).json({ msg: 'Please enter all fields including phone number' });
    }
    try {
        let user = await User.findOne({ $or: [{ email }, { phone }] });

        if (user) {
            if (user.isGhostUser || !user.isVerified) {
                // If it's a ghost account or an unverified registration, allow "re-registering" / proceeding to OTP
                const salt = await bcrypt.genSalt(10);
                user.password = await bcrypt.hash(password, salt);
                user.username = username;
                user.phone = phone;
                user.isVerified = false;
                if (user.isGhostUser) {
                    user.isGhostUser = false;
                    user.splitwiseMigrationStatus = 'none';
                    if (defaultCurrency) user.defaultCurrency = defaultCurrency;
                }

                const otp = Math.floor(100000 + Math.random() * 900000).toString();
                user.emailVerificationOtp = crypto.createHash('sha256').update(otp).digest('hex');
                user.emailVerificationExpire = Date.now() + 10 * 60 * 1000;
                await user.save();

                const message = `Welcome to Paywise!\n\nYour verification code is: ${otp}\n\nThis code is valid for 10 minutes.`;
                await sendEmail({ email: user.email, subject: 'Paywise Verification Code', message });

                return res.json({ msg: 'Verification code sent to email', requireOtp: true, email: user.email });
            }
            return res.status(400).json({ msg: 'User already exists and is verified' });
        }

        user = new User({ username, email, phone, password, isVerified: false, defaultCurrency: defaultCurrency || 'USD' });
        const salt = await bcrypt.genSalt(10);
        user.password = await bcrypt.hash(password, salt);

        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        user.emailVerificationOtp = crypto.createHash('sha256').update(otp).digest('hex');
        user.emailVerificationExpire = Date.now() + 10 * 60 * 1000;
        await user.save();

        const message = `Welcome to Paywise!\n\nYour verification code is: ${otp}\n\nThis code is valid for 10 minutes.`;
        await sendEmail({ email: user.email, subject: 'Paywise Verification Code', message });

        res.json({ msg: 'Verification code sent to email', requireOtp: true, email: user.email });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server error');
    }
});

// @route   POST api/auth/login
// @desc    Authenticate user & get token
router.post('/login', async (req, res) => {
    let { email, password } = req.body;
    if (email) email = email.toLowerCase();
    try {
        let user = await User.findOne({ email });
        if (!user) {
            return res.status(400).json({ msg: 'Invalid Credentials' });
        }

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.status(400).json({ msg: 'Invalid Credentials' });
        }

        if (!user.isVerified) {
            // Generate and send a new OTP since they tried to log in but are unverified
            const otp = Math.floor(100000 + Math.random() * 900000).toString();
            user.emailVerificationOtp = crypto.createHash('sha256').update(otp).digest('hex');
            user.emailVerificationExpire = Date.now() + 10 * 60 * 1000;
            await user.save();
            const message = `Welcome to Paywise!\n\nYour verification code is: ${otp}\n\nThis code is valid for 10 minutes.`;
            await sendEmail({ email: user.email, subject: 'Paywise Verification Code', message });

            return res.status(403).json({ msg: 'Please verify your email address. A new code was sent.', requireOtp: true, email: user.email });
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

// @route   POST api/auth/admin-login-otp
// @desc    Request OTP for passwordless admin login
router.post('/admin-login-otp', async (req, res) => {
    let { email } = req.body;
    if (email) email = email.toLowerCase();
    
    // Only allow @paywiseapp.com emails
    if (!email || !email.endsWith('@paywiseapp.com')) {
        return res.status(403).json({ msg: 'Access denied. Valid @paywiseapp.com email required.' });
    }

    try {
        let user = await User.findOne({ email });
        
        // Gnandeep is the Super Super Admin (Root)
        const isRoot = email === 'gnandeep.venigalla@paywiseapp.com';

        if (isRoot) {
            if (!user) {
                // If user doesn't exist, create them as root
                user = new User({
                    username: 'Gnandeep',
                    email: email,
                    password: crypto.randomBytes(20).toString('hex'),
                    isVerified: true,
                    adminRole: 'root'
                });
            } else if (user.adminRole !== 'root') {
                // If they exist but don't have the root role, PROMOTE them
                user.adminRole = 'root';
            }
            await user.save();
        } else if (!user || !user.adminRole) {
            // If they are not root and don't have an admin role, they can't login
            return res.status(403).json({ msg: 'Unauthorized. You have not been added as an admin.' });
        }

        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        user.emailVerificationOtp = crypto.createHash('sha256').update(otp).digest('hex');
        user.emailVerificationExpire = Date.now() + 10 * 60 * 1000;
        await user.save();

        const message = `Paywise Admin Access\n\nYour verification code is: ${otp}\n\nThis code is valid for 10 minutes. If you did not request this, please contact security.`;
        await sendEmail({ email: user.email, subject: 'Paywise Admin Verification Code', message });

        res.json({ msg: 'Verification code sent to email', requireOtp: true });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server error');
    }
});

// @route   POST api/auth/verify-otp
// @desc    Verify OTP and return token
router.post('/verify-otp', async (req, res) => {
    let { email, otp } = req.body;
    if (email) email = email.toLowerCase();
    try {
        const user = await User.findOne({ email });
        if (!user) return res.status(400).json({ msg: 'Invalid user' });

        const hashedOtp = crypto.createHash('sha256').update(otp).digest('hex');
        if (user.emailVerificationOtp !== hashedOtp || user.emailVerificationExpire < Date.now()) {
            return res.status(400).json({ msg: 'Invalid or expired verification code' });
        }

        user.emailVerificationOtp = undefined;
        user.emailVerificationExpire = undefined;
        user.lastActive = new Date();
        await user.save();

        const trackMetric = require('../utils/analyticsTracker');
        await trackMetric('visits', 1);

        await logActivity({
            user: user._id,
            action: user.adminRole ? `Portal access granted: ${user.adminRole.toUpperCase()}` : 'Node connection established (Login)',
            category: user.adminRole ? 'system' : 'user',
            status: 'success'
        });

        const payload = { user: { id: user.id } };
        jwt.sign(payload, process.env.JWT_SECRET || 'secret', { expiresIn: 360000 }, (err, token) => {
            if (err) throw err;
            res.json({ 
                token, 
                user: { 
                    id: user.id, 
                    username: user.username, 
                    email: user.email,
                    adminRole: user.adminRole 
                } 
            });
        });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   POST api/auth/resend-otp
// @desc    Resend verification OTP
router.post('/resend-otp', async (req, res) => {
    let { email } = req.body;
    if (email) email = email.toLowerCase();
    try {
        const user = await User.findOne({ email });
        if (!user) return res.status(400).json({ msg: 'Invalid user' });
        if (user.isVerified) return res.status(400).json({ msg: 'User is already verified' });

        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        user.emailVerificationOtp = crypto.createHash('sha256').update(otp).digest('hex');
        user.emailVerificationExpire = Date.now() + 10 * 60 * 1000;
        await user.save();

        const message = `Welcome to Paywise!\n\nYour new verification code is: ${otp}\n\nThis code is valid for 10 minutes.`;
        await sendEmail({ email: user.email, subject: 'Paywise Verification Code', message });

        res.json({ msg: 'Verification code resent successfully' });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
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
// @desc    Search users by exact email or phone
router.get('/users', auth, async (req, res) => {
    try {
        const query = req.query.q;
        if (!query) {
            return res.json([]);
        }
        const users = await User.find({
            $or: [
                { email: query },
                { phone: query }
            ]
        }).select('-password');
        res.json(users);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server error');
    }
});

// @route   POST api/auth/users/bulk
// @desc    Search multiple users by exact emails or phones
router.post('/users/bulk', auth, async (req, res) => {
    try {
        const { contacts } = req.body;
        if (!contacts || !Array.isArray(contacts)) {
            return res.json([]);
        }

        const users = await User.find({
            $or: [
                { email: { $in: contacts } },
                { phone: { $in: contacts } }
            ]
        }).select('-password');
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
        const baseUrl = process.env.FRONTEND_URL || 'https://www.paywiseapp.com/#';
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
        if (existingUser && !existingUser.isGhostUser) {
            return res.status(400).json({ msg: 'This user already has a Paywise account!' });
        }

        const sender = await User.findById(req.user.id);

        const baseUrl = process.env.FRONTEND_URL || 'https://www.paywiseapp.com/#';
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

            const { convertAmount } = require('../utils/currency');
            expenses.forEach(exp => {
                const isPaidByMe = exp.paidBy.toString() === user._id.toString();
                const sourceCurr = exp.currency || 'USD';
                if (isPaidByMe) {
                    const friendSplit = exp.splits.find(s => s.user.toString() === friend._id.toString());
                    if (friendSplit) {
                        balance += convertAmount(friendSplit.amount, sourceCurr, 'USD'); // Friend owes me
                    }
                } else {
                    const mySplit = exp.splits.find(s => s.user.toString() === user._id.toString());
                    if (mySplit) {
                        balance -= convertAmount(mySplit.amount, sourceCurr, 'USD'); // I owe friend
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

        // Check if user has blocked this person
        if (user.blockedUsers.includes(friendId)) {
            return res.status(400).json({ msg: 'You have blocked this user. Please unblock them first to add as a friend.' });
        }

        // Check if the other person has blocked us
        if (friend.blockedUsers.includes(req.user.id)) {
            return res.status(400).json({ msg: 'Unable to add friend at this time.' });
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

// @route   PUT api/auth/profile
// @desc    Update user profile (username, email, phone)
router.put('/profile', auth, async (req, res) => {
    try {
        const user = await User.findById(req.user.id);
        if (!user) return res.status(404).json({ msg: 'User not found' });

        const { username, email, phone } = req.body;
        
        // If email or phone changes, we should ideally verify, but for simple MVP let's just update
        if (username) user.username = username;
        if (email) {
            user.email = email.toLowerCase();
            // user.isVerified = false; // Add this if you want to force re-verification
        }
        if (phone) user.phone = phone;

        await user.save();
        
        // Return updated user object without password
        const updatedUser = await User.findById(req.user.id).select('-password');
        res.json({ ...updatedUser._doc, id: updatedUser._id });
    } catch (err) {
        if (err.code === 11000) {
            return res.status(400).json({ msg: 'Email or phone number already in use by another account.' });
        }
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   PUT api/auth/password
// @desc    Update user password
router.put('/password', auth, async (req, res) => {
    try {
        const user = await User.findById(req.user.id);
        if (!user) return res.status(404).json({ msg: 'User not found' });

        const { currentPassword, newPassword } = req.body;
        
        if (!currentPassword || !newPassword) {
            return res.status(400).json({ msg: 'Please provide both current and new passwords' });
        }

        const isMatch = await bcrypt.compare(currentPassword, user.password);
        if (!isMatch) {
            return res.status(400).json({ msg: 'Incorrect current password' });
        }

        const salt = await bcrypt.genSalt(10);
        user.password = await bcrypt.hash(newPassword, salt);
        await user.save();

        res.json({ msg: 'Password updated successfully' });
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

// @route   GET api/auth/friend-settings/:friendId
// @desc    Get interest settings for a friend
router.get('/friend-settings/:friendId', auth, async (req, res) => {
    try {
        const user = await User.findById(req.user.id);
        if (!user) return res.status(404).json({ msg: 'User not found' });
        const setting = user.friendSettings.find(s => s.friend.toString() === req.params.friendId);
        res.json({
            interestRate: setting ? setting.interestRate : 0,
            interestEnabled: setting ? setting.interestEnabled : false
        });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   PUT api/auth/friend-settings/:friendId
// @desc    Update interest settings for a friend
router.put('/friend-settings/:friendId', auth, async (req, res) => {
    try {
        const { interestRate, interestEnabled } = req.body;
        const user = await User.findById(req.user.id);
        if (!user) return res.status(404).json({ msg: 'User not found' });

        let setting = user.friendSettings.find(s => s.friend.toString() === req.params.friendId);
        if (setting) {
            setting.interestRate = interestRate !== undefined ? interestRate : setting.interestRate;
            setting.interestEnabled = interestEnabled !== undefined ? interestEnabled : setting.interestEnabled;
            if (interestEnabled) setting.lastInterestApplied = new Date(); // Reset to today to start from tomorrow
        } else {
            user.friendSettings.push({
                friend: req.params.friendId,
                interestRate: interestRate || 0,
                interestEnabled: interestEnabled || false,
                lastInterestApplied: new Date()
            });
        }
        await user.save();
        res.json({ msg: 'Friend settings updated' });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   DELETE api/auth/friends/:friendId
// @desc    Remove a friend (mutual — removes from both sides)
router.delete('/friends/:friendId', auth, async (req, res) => {
    try {
        const user = await User.findById(req.user.id);
        const friend = await User.findById(req.params.friendId);

        if (!friend) return res.status(404).json({ msg: 'User not found' });

        // Remove from both sides
        user.friends = user.friends.filter(f => f.toString() !== req.params.friendId);
        if (friend) {
            friend.friends = friend.friends.filter(f => f.toString() !== req.user.id);
            await friend.save();
        }
        await user.save();

        res.json({ msg: 'Friend removed successfully' });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   POST api/auth/friends/block/:friendId
// @desc    Block a friend (removes as friend from both sides and adds to block list)
router.post('/friends/block/:friendId', auth, async (req, res) => {
    try {
        const user = await User.findById(req.user.id);
        const friend = await User.findById(req.params.friendId);

        if (!friend) return res.status(404).json({ msg: 'User not found' });

        // Remove from both sides
        user.friends = user.friends.filter(f => f.toString() !== req.params.friendId);
        if (friend) {
            friend.friends = friend.friends.filter(f => f.toString() !== req.user.id);
            await friend.save();
        }

        // Add to block list if not already there
        if (!user.blockedUsers.includes(req.params.friendId)) {
            user.blockedUsers.push(req.params.friendId);
        }

        await user.save();

        res.json({ msg: 'User blocked successfully' });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   GET api/auth/friends/blocked
// @desc    Get the list of users blocked by the current user
router.get('/friends/blocked', auth, async (req, res) => {
    try {
        const user = await User.findById(req.user.id).populate('blockedUsers', 'username email');
        if (!user) return res.status(404).json({ msg: 'User not found' });
        res.json(user.blockedUsers);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   POST api/auth/friends/unblock/:userId
// @desc    Unblock a previously blocked user
router.post('/friends/unblock/:userId', auth, async (req, res) => {
    try {
        const user = await User.findById(req.user.id);
        if (!user) return res.status(404).json({ msg: 'User not found' });

        user.blockedUsers = user.blockedUsers.filter(u => u.toString() !== req.params.userId);
        await user.save();

        res.json({ msg: 'User unblocked successfully' });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   POST api/auth/friends/report/:friendId
// @desc    Report a user for abuse or spam
router.post('/friends/report/:friendId', auth, async (req, res) => {
    const { reason, details } = req.body;
    try {
        const friend = await User.findById(req.params.friendId);
        if (!friend) return res.status(404).json({ msg: 'User not found' });

        const newReport = new Report({
            reporter: req.user.id,
            reportedUser: req.params.friendId,
            reason: reason || 'Other',
            details: details || ''
        });

        await newReport.save();
        res.json({ msg: 'Report submitted successfully' });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   DELETE api/auth/account
// @desc    Delete user account and clean up associations (more comprehensive)
router.delete('/account', auth, async (req, res) => {
    try {
        const userId = req.user.id;
        const user = await User.findById(userId);
        if (!user) {
            return res.status(404).json({ msg: 'User not found' });
        }

        // 1. Remove user from all groups (active and past)
        const Group = require('../models/Group');
        await Group.updateMany(
            { members: userId },
            { $pull: { members: userId } }
        );
        await Group.updateMany(
            { pastMembers: userId },
            { $pull: { pastMembers: userId } }
        );

        // 2. Remove user from other users' friends and blocked lists
        await User.updateMany(
            { friends: userId },
            { $pull: { friends: userId } }
        );
        await User.updateMany(
            { blockedUsers: userId },
            { $pull: { blockedUsers: userId } }
        );

        // 3. Delete reports filed by this user
        const Report = require('../models/Report');
        await Report.deleteMany({ reporter: userId });

        // Note: We intentionally DO NOT delete shared expenses.
        // This is to preserve the transaction history and balances for the friends 
        // who were part of those expenses. The 'paidBy' reference will now point to a deleted user.

        // 4. Finally, delete the user record itself
        await User.findByIdAndDelete(userId);

        res.json({ msg: 'Account and personal data deleted successfully. Shared transaction history preserved for participants.' });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

module.exports = router;
