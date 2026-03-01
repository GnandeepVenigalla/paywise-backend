const express = require('express');
const router = express.Router();
const axios = require('axios');
const auth = require('../middleware/auth');
const User = require('../models/User');
const Group = require('../models/Group');
const Expense = require('../models/Expense');

// Splitwise API Config (These should be in .env)
const CLIENT_ID = process.env.SPLITWISE_CLIENT_ID;
const CLIENT_SECRET = process.env.SPLITWISE_CLIENT_SECRET;
const REDIRECT_URI = process.env.SPLITWISE_REDIRECT_URI || 'http://localhost:5173/splitwise-callback';

/**
 * @route   GET api/splitwise/auth-url
 * @desc    Get Splitwise OAuth URL
 */
router.get('/auth-url', auth, (req, res) => {
    // Determine redirect URI: use .env if present, otherwise decide based on origin
    let redirectUri = process.env.SPLITWISE_REDIRECT_URI || 'http://localhost:5173/Paywise/#/splitwise-callback';

    const origin = req.get('origin') || '';
    if (origin.includes('localhost')) {
        redirectUri = 'http://localhost:5173/Paywise/#/splitwise-callback';
    }

    const url = `https://secure.splitwise.com/oauth/authorize?response_type=code&client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(redirectUri)}`;
    res.json({ url });
});

/**
 * @route   POST api/splitwise/migrate
 * @desc    Exchange code for token and migrate data
 */
router.post('/migrate', auth, async (req, res) => {
    const { code, redirectUri } = req.body;

    // Choose the correct redirect URI for token exchange
    const actualRedirectUri = redirectUri || process.env.SPLITWISE_REDIRECT_URI || 'http://localhost:5173/Paywise/#/splitwise-callback';

    try {
        // 1. Exchange code for access token
        const tokenResponse = await axios.post('https://secure.splitwise.com/oauth/token', {
            grant_type: 'authorization_code',
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET,
            code,
            redirect_uri: actualRedirectUri
        });

        const accessToken = tokenResponse.data.access_token;

        // Update user status to pending
        await User.findByIdAndUpdate(req.user.id, {
            splitwiseToken: accessToken,
            splitwiseMigrationStatus: 'pending'
        });

        // 2. Fetch Splitwise Groups
        const groupsResponse = await axios.get('https://secure.splitwise.com/api/v3.0/get_groups', {
            headers: { Authorization: `Bearer ${accessToken}` }
        });

        const swGroups = groupsResponse.data.groups;

        // 3. Migrate Groups & Expenses (Simplified logic)
        for (const swGroup of swGroups) {
            // Check if group already exists (by name for demo, ideally by splitwise_id)
            let group = await Group.findOne({ name: swGroup.name, members: req.user.id });

            if (!group) {
                group = new Group({
                    name: swGroup.name,
                    members: [req.user.id], // In real app, we'd search/invite Splitwise members too
                    createdBy: req.user.id
                });
                await group.save();
            }

            // 4. Fetch Expenses for this group
            const expensesResponse = await axios.get(`https://secure.splitwise.com/api/v3.0/get_expenses?group_id=${swGroup.id}`, {
                headers: { Authorization: `Bearer ${accessToken}` }
            });

            const swExpenses = expensesResponse.data.expenses;

            for (const swExp of swExpenses) {
                // Create Expense in Paywise
                const newExp = new Expense({
                    description: swExp.description,
                    amount: parseFloat(swExp.cost),
                    date: new Date(swExp.date),
                    paidBy: req.user.id, // Simplified: Assuming current user paid for migration demo
                    group: group._id,
                    addedBy: req.user.id,
                    splits: [{
                        user: req.user.id,
                        amount: parseFloat(swExp.cost) // Simplified split
                    }]
                });
                await newExp.save();

                group.expenses.push(newExp._id);
            }
            await group.save();
        }

        // Update user status to completed
        await User.findByIdAndUpdate(req.user.id, { splitwiseMigrationStatus: 'completed' });

        res.json({ msg: 'Migration successful', groupsCount: swGroups.length });
    } catch (err) {
        console.error('Splitwise migration error:', err.response?.data || err.message);
        res.status(500).json({ msg: 'Migration failed. Check your Splitwise connectivity.' });
    }
});

module.exports = router;
