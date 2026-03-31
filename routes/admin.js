const express = require('express');
const router = express.Router();
const User = require('../models/User');
const Expense = require('../models/Expense');
const Group = require('../models/Group');
const Activity = require('../models/Activity');
const Analytics = require('../models/Analytics');
const Bug = require('../models/Bug');
const auth = require('../middleware/auth');
const logActivity = require('../utils/activityLogger');

// Middleware to check if user is admin
// For now, let's assume all authenticated users can access admin for the dev phase
// or we can check for a specific email or role if it existed.
// Since no roles exist, I'll just use the auth middleware.
// Middleware to check if user is admin
const isAdmin = async (req, res, next) => {
    try {
        const user = await User.findById(req.user.id);
        if (!user) return res.status(403).json({ msg: 'Access denied. User not found.' });

        // Backup check: Ensure the root user always has access even if the role field isn't indexed yet
        if (user.email === 'gnandeep.venigalla@paywiseapp.com') {
            req.adminRole = 'root';
            return next();
        }

        if (!user.adminRole) {
            return res.status(403).json({ msg: 'Access denied. Admins only.' });
        }

        req.adminRole = user.adminRole;
        next();
    } catch (err) {
        res.status(500).send('Server Error');
    }
};

// Middleware to check specific role permissions
const checkPerms = (requiredRoles) => (req, res, next) => {
    if (requiredRoles.includes(req.adminRole)) {
        next();
    } else {
        res.status(403).json({ msg: `Permission denied. Required: ${requiredRoles.join(' or ')}` });
    }
};

// @route   POST api/admin/council
// @desc    Add a new employee/admin (Root only)
router.post('/council', auth, isAdmin, checkPerms(['root']), async (req, res) => {
    const { email, username, role } = req.body;

    if (!email || !email.endsWith('@paywiseapp.com')) {
        return res.status(400).json({ msg: 'Valid @paywiseapp.com email required.' });
    }

    try {
        let user = await User.findOne({ email });

        if (user) {
            user.adminRole = role;
            if (username) user.username = username;
        } else {
            user = new User({
                username: username || email.split('@')[0],
                email: email,
                password: require('crypto').randomBytes(20).toString('hex'),
                isVerified: true,
                adminRole: role
            });
        }

        await user.save();

        await logActivity({
            user: req.user.id,
            action: `Personnel ${user.username} clearance level updated to ${role}`,
            category: 'system',
            status: 'success'
        });

        res.json({ msg: 'Employee added/updated successfully', user });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   GET api/admin/stats
// @desc    Get dashboard statistics
router.get('/stats', auth, isAdmin, checkPerms(['root', 'super_admin', 'admin', 'read_only']), async (req, res) => {
    try {
        const totalUsers = await User.countDocuments({ isGhostUser: false });
        const totalExpenses = await Expense.countDocuments();
        const totalGroups = await Group.countDocuments();

        // DAU/MAU Calculation
        const now = new Date();
        const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        const last30d = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

        const dau = await User.countDocuments({ lastActive: { $gte: last24h }, isGhostUser: false });
        const mau = await User.countDocuments({ lastActive: { $gte: last30d }, isGhostUser: false });

        // Aggregate Analytics
        const analyticsData = await Analytics.find({ date: { $gte: last30d } });
        const totalVisits = analyticsData.reduce((sum, day) => sum + (day.visits || 0), 0);
        const totalAdImpressions = analyticsData.reduce((sum, day) => sum + (day.adImpressions || 0), 0);
        const totalAdRequests = analyticsData.reduce((sum, day) => sum + (day.adRequests || 0), 0);
        const totalAdClicks = analyticsData.reduce((sum, day) => sum + (day.adClicks || 0), 0);
        const totalAdRevenue = analyticsData.reduce((sum, day) => sum + (day.adRevenue || 0), 0);
        const totalAiRequests = analyticsData.reduce((sum, day) => sum + (day.aiRequests || 0), 0);
        const totalAiInputTokens = analyticsData.reduce((sum, day) => sum + (day.aiInputTokens || 0), 0);
        const totalAiOutputTokens = analyticsData.reduce((sum, day) => sum + (day.aiOutputTokens || 0), 0);

        const adRevenue = totalAdRevenue.toFixed(2);
        const ecpm = totalAdImpressions > 0 ? ((totalAdRevenue / totalAdImpressions) * 1000).toFixed(2) : 0;
        const ctr = totalAdImpressions > 0 ? ((totalAdClicks / totalAdImpressions) * 100).toFixed(2) : 0;
        const fillRate = totalAdRequests > 0 ? ((totalAdImpressions / totalAdRequests) * 100).toFixed(2) : 0;

        // Stats for the last 7 days
        const sevenDaysAgo = new Date();
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

        const newUsersLast7Days = await User.countDocuments({
            createdAt: { $gte: sevenDaysAgo },
            isGhostUser: false
        });

        // User growth data for chart
        const userGrowth = [];
        for (let i = 6; i >= 0; i--) {
            const date = new Date();
            date.setDate(date.getDate() - i);
            const startOfDay = new Date(date.setHours(0, 0, 0, 0));
            const endOfDay = new Date(date.setHours(23, 59, 59, 999));

            const count = await User.countDocuments({
                createdAt: { $gte: startOfDay, $lte: endOfDay },
                isGhostUser: false
            });

            userGrowth.push({
                date: startOfDay.toLocaleDateString('en-US', { weekday: 'short' }),
                count
            });
        }

        const activeSessions = await User.countDocuments({ lastActive: { $gte: new Date(Date.now() - 15 * 60 * 1000) }, isGhostUser: false });
        const verifiedUsers = await User.countDocuments({ isVerified: true, isGhostUser: false });
        const distinctTxUsers = await Expense.distinct('paidBy');
        const usersWithTransactions = distinctTxUsers.length;

        const fraudAttempts = await Activity.countDocuments({ status: { $in: ['error', 'warning'] } });
        const totalActivities = await Activity.countDocuments();
        const fraudRate = totalActivities > 0 ? ((fraudAttempts / totalActivities) * 100).toFixed(2) : 0;

        // Expense volume data for chart
        const expenseVolume = [];
        for (let i = 6; i >= 0; i--) {
            const date = new Date();
            date.setDate(date.getDate() - i);
            const startOfDay = new Date(date.setHours(0, 0, 0, 0));
            const endOfDay = new Date(date.setHours(23, 59, 59, 999));

            const expenses = await Expense.find({
                createdAt: { $gte: startOfDay, $lte: endOfDay }
            });

            const totalAmount = expenses.reduce((sum, exp) => sum + (exp.amount || 0), 0);

            expenseVolume.push({
                date: startOfDay.toLocaleDateString('en-US', { weekday: 'short' }),
                amount: totalAmount
            });
        }

        // Fetch recent activities
        const recentActivities = await Activity.find()
            .populate('user', 'username email')
            .sort({ createdAt: -1 })
            .limit(10);

        // Fetch top 10 most active users
        const topUsers = await User.find({ isGhostUser: false, email: { $not: /@paywiseapp\.com$/ } })
            .select('username email lastActive')
            .sort({ lastActive: -1 })
            .limit(10);

        res.json({
            summary: {
                totalUsers,
                totalExpenses,
                adRevenue,
                totalGroups,
                newUsersLast7Days,
                dau,
                mau,
                activeSessions,
                verifiedUsers,
                usersWithTransactions,
                fraudRate,
                fraudAttempts,
                totalVisits,
                adPerformance: {
                    impressions: totalAdImpressions,
                    requests: totalAdRequests,
                    clicks: totalAdClicks,
                    ecpm,
                    ctr,
                    fillRate
                },
                aiPerformance: {
                    totalRequests: totalAiRequests,
                    inputTokens: totalAiInputTokens,
                    outputTokens: totalAiOutputTokens,
                    totalTokens: totalAiInputTokens + totalAiOutputTokens
                }
            },
            charts: {
                userGrowth,
                expenseVolume
            },
            recentActivities,
            topUsers
        });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   GET api/admin/users
// @desc    Get regular users (excluding staff)
router.get('/users', auth, isAdmin, checkPerms(['root', 'super_admin', 'admin', 'moderator', 'read_only']), async (req, res) => {
    try {
        const users = await User.find({
            isGhostUser: false,
            email: { $not: /@paywiseapp\.com$/ }
        })
            .select('-password')
            .sort({ createdAt: -1 });
        res.json(users);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   GET api/admin/council
// @desc    Get staff members (@paywiseapp.com)
router.get('/council', auth, isAdmin, checkPerms(['root', 'super_admin']), async (req, res) => {
    try {
        const users = await User.find({
            isGhostUser: false,
            email: /@paywiseapp\.com$/
        })
            .select('-password')
            .sort({ createdAt: -1 });
        res.json(users);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});



// @route   POST api/admin/users/:id/action
// @desc    Perform action on user (Root, Super Admin, Admin)
router.post('/users/:id/action', auth, isAdmin, checkPerms(['root', 'super_admin', 'admin', 'moderator']), async (req, res) => {
    try {
        const { action } = req.body;
        const user = await User.findById(req.params.id);
        if (!user) return res.status(404).json({ msg: 'User not found' });

        if (action === 'freeze' || action === 'revoke') {
            if (req.adminRole === 'moderator') return res.status(403).json({ msg: 'Moderators cannot freeze accounts.' });
            user.isVerified = false;
            await logActivity({
                user: req.user.id,
                action: `Access revoked / frozen for node ${user.username}`,
                category: 'security',
                status: 'warning'
            });
        } else if (action === 'unfreeze') {
            if (req.adminRole === 'moderator') return res.status(403).json({ msg: 'Moderators cannot unfreeze accounts.' });
            user.isVerified = true;
            await logActivity({
                user: req.user.id,
                action: `Access restored / unfrozen for node ${user.username}`,
                category: 'security',
                status: 'success'
            });
        } else if (action === 'flag') {
            user.isVerified = false; // Just un-verifying acts as a flag for now
            await logActivity({
                user: req.user.id,
                action: `Node ${user.username} flagged for review`,
                category: 'security',
                status: 'warning'
            });
        } else if (action === 'verify') {
            user.isVerified = true;
            await logActivity({
                user: req.user.id,
                action: `Node ${user.username} verification confirmed`,
                category: 'security',
                status: 'success'
            });
        } else {
            return res.status(400).json({ msg: 'Invalid action' });
        }

        await user.save();
        res.json({ msg: `Action ${action} executed` });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   DELETE api/admin/users/:id
// @desc    Delete a user (Super Admin & Root only)
router.delete('/users/:id', auth, isAdmin, checkPerms(['root', 'super_admin']), async (req, res) => {
    try {
        const user = await User.findById(req.params.id);
        const username = user ? user.username : 'Unknown';

        await User.findByIdAndDelete(req.params.id);

        await logActivity({
            user: req.user.id,
            action: `Node ${username} permanently purged from kernel`,
            category: 'security',
            status: 'error'
        });

        res.json({ msg: 'User permanently purged from system' });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   POST api/admin/release/beta-link
// @desc    Generate a secure beta link (Root/Super Admin/Admin)
router.post('/release/beta-link', auth, isAdmin, checkPerms(['root', 'super_admin', 'admin']), async (req, res) => {
    try {
        const betaToken = require('crypto').randomBytes(16).toString('hex');
        // Use HashRouter format for GitHub Pages compatibility
        const betaUrl = `https://paywise-two.vercel.app/#/beta?token=${betaToken}`;

        await logActivity({
            user: req.user.id,
            action: `Generated secure beta access link for v2.4.0-beta.1`,
            category: 'system',
            status: 'success'
        });

        res.json({ url: betaUrl, token: betaToken });
    } catch (err) {
        res.status(500).send('Server Error');
    }
});

// @route   POST api/admin/release/deploy
// @desc    Mock production deployment / Git push (Root/Super Admin)
router.post('/release/deploy', auth, isAdmin, checkPerms(['root', 'super_admin']), async (req, res) => {
    try {
        await logActivity({
            user: req.user.id,
            action: `Initiated production deployment sequence for v2.4.0`,
            category: 'system',
            status: 'success'
        });

        // In a real environment, you might use 'exec' to run a git push or trigger a webhook
        // For now, we simulate the success of the deployment pipeline
        res.json({ msg: 'Deployment signal sent to Git. Production update in progress.' });
    } catch (err) {
        res.status(500).send('Server Error');
    }
});

// @route   GET api/admin/release/bugs
// @desc    Get all beta bugs (Root/Super Admin)
router.get('/release/bugs', auth, isAdmin, checkPerms(['root', 'super_admin', 'admin', 'read_only']), async (req, res) => {
    try {
        const bugs = await Bug.find().populate('reporter', 'username').sort({ createdAt: -1 });
        res.json(bugs);
    } catch (err) {
        res.status(500).send('Server Error');
    }
});

// @route   POST api/admin/release/bugs
// @desc    Report a new beta bug
router.post('/release/bugs', auth, isAdmin, async (req, res) => {
    try {
        const { description, severity } = req.body;
        const newBug = new Bug({
            description,
            severity,
            reporter: req.user.id
        });
        await newBug.save();

        await logActivity({
            user: req.user.id,
            action: `Reported beta bug: ${description.substring(0, 30)}...`,
            category: 'system',
            status: 'warning'
        });

        res.json(newBug);
    } catch (err) {
        res.status(500).send('Server Error');
    }
});

// @route   PUT api/admin/release/bugs/:id/resolve
// @desc    Mark bug as resolved
router.put('/release/bugs/:id/resolve', auth, isAdmin, checkPerms(['root', 'super_admin', 'admin']), async (req, res) => {
    try {
        const bug = await Bug.findById(req.params.id);
        if (!bug) return res.status(404).json({ msg: 'Bug not found' });

        bug.status = 'resolved';
        await bug.save();

        await logActivity({
            user: req.user.id,
            action: `Resolved beta bug: ${bug.description.substring(0, 30)}...`,
            category: 'system',
            status: 'success'
        });

        res.json(bug);
    } catch (err) {
        res.status(500).send('Server Error');
    }
});

const Notification = require('../models/Notification');

// ==========================================
// NOTIFICATIONS API
// ==========================================

// Get all recent notifications for admin
router.get('/notifications', auth, isAdmin, async (req, res) => {
  try {
    const role = req.adminRole;
    const query = {};
    
    // Support targetRole if the notification is only meant for super_admin
    if (role !== 'root' && role !== 'super_admin') {
      query.$or = [
        { targetRole: 'all' },
        { targetRole: role }
      ];
    }

    const unreadCount = await Notification.countDocuments({ ...query, isRead: false });
    const notifications = await Notification.find(query).sort({ createdAt: -1 }).limit(50);
    
    res.json({ unreadCount, notifications });
  } catch (err) {
    console.error("Error fetching admin notifications:", err);
    res.status(500).json({ msg: 'Server error fetching notifications' });
  }
});

// Mark a specific notification as read
router.put('/notifications/:id/read', auth, isAdmin, async (req, res) => {
  try {
    const notification = await Notification.findByIdAndUpdate(
      req.params.id,
      { isRead: true },
      { new: true }
    );
    res.json(notification);
  } catch (err) {
    res.status(500).json({ msg: 'Error updating notification status' });
  }
});

// Mark all as read
router.put('/notifications/read-all', auth, isAdmin, async (req, res) => {
  try {
    await Notification.updateMany({ isRead: false }, { isRead: true });
    res.json({ msg: 'All notifications marked as read' });
  } catch (err) {
    res.status(500).json({ msg: 'Error updating notifications' });
  }
});

// Support Tickets Admin API
const Support = require('../models/Support');

router.get('/support', auth, isAdmin, async (req, res) => {
    try {
        const tickets = await Support.find().populate('user', 'username email').sort({ createdAt: -1 });
        res.json(tickets);
    } catch (err) {
        res.status(500).send('Server Error');
    }
});

router.put('/support/:id', auth, isAdmin, async (req, res) => {
    try {
        const { status, adminResponse } = req.body;
        const updateData = { status, adminResponse };

        // Record exact closure time for auto-cleanup protocol (1 week cycle)
        if (status === 'closed') {
            updateData.closedAt = new Date();
        } else {
            updateData.closedAt = null; // Reset if reopened
        }

        // If there's a response, also push it to the unified chat thread
        if (adminResponse) {
            updateData.$push = {
                replies: {
                    sender: req.user.id,
                    message: adminResponse,
                    isAdmin: true,
                    createdAt: new Date()
                }
            };
        }

        const ticket = await Support.findByIdAndUpdate(
            req.params.id, 
            updateData, 
            { new: true }
        );
        res.json(ticket);
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
});

// @route   POST api/admin/maintenance/phone-reminders
// @desc    Send bulk reminders to all users missing phone numbers
router.post('/maintenance/phone-reminders', auth, isAdmin, checkPerms(['root', 'super_admin']), async (req, res) => {
    try {
        const usersMissingPhone = await User.find({ 
            $or: [
                { phone: { $exists: false } },
                { phone: null },
                { phone: '' }
            ],
            isGhostUser: false
        });

        const sendEmail = require('../utils/sendEmail');
        const { createNotification } = require('../utils/notificationService');

        let successCount = 0;
        let failCount = 0;

        for (const user of usersMissingPhone) {
            try {
                // 1. In-app notification
                await createNotification({
                    recipientId: user.id,
                    title: 'Action Required: Add Phone Number',
                    message: 'Your account is missing a phone number. Please update it in Settings to secure your account.',
                    category: 'system',
                    actionUrl: '/account'
                });

                // 2. Email Nudge
                await sendEmail({
                    email: user.email,
                    subject: 'Important: Complete your Paywise profile',
                    message: `Hi ${user.username},\n\nWe noticed your Paywise account is missing a phone number.\n\nAdding a phone number helps your friends find you easily and keeps your account secure.\n\nPlease update it here: ${process.env.FRONTEND_URL || 'https://www.paywiseapp.com/#/account'}\n\nHappy splitting!\nThe Paywise Team`
                });

                successCount++;
            } catch (err) {
                console.error(`Failed to notify user ${user.email}:`, err.message);
                failCount++;
            }
        }

        await logActivity({
            user: req.user.id,
            action: `Bulk phone reminders sent. Success: ${successCount}, Failed: ${failCount}`,
            category: 'system',
            status: 'success'
        });

        res.json({ msg: `Process complete. Reminders sent to ${successCount} users. Errors: ${failCount}` });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

module.exports = router;
