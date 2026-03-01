const express = require('express');
const router = express.Router();
const axios = require('axios');
const auth = require('../middleware/auth');
const User = require('../models/User');
const Group = require('../models/Group');
const Expense = require('../models/Expense');

const CLIENT_ID = process.env.SPLITWISE_CLIENT_ID;
const CLIENT_SECRET = process.env.SPLITWISE_CLIENT_SECRET;

// ─────────────────────────────────────────────────────────────────────────────
// OAUTH FLOW  (for regular users — requires production deployment)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @route   GET api/splitwise/auth-url
 * @desc    Get Splitwise OAuth authorization URL
 */
router.get('/auth-url', auth, (req, res) => {
    // Always use the registered production callback URL.
    // Local dev testing should use the API token flow instead.
    const redirectUri = process.env.SPLITWISE_REDIRECT_URI || 'https://gnandeepvenigalla.github.io/Paywise/splitwise-callback.html';
    const url = `https://secure.splitwise.com/oauth/authorize?response_type=code&client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(redirectUri)}`;
    res.json({ url, redirectUri });
});

/**
 * @route   POST api/splitwise/migrate
 * @desc    Exchange OAuth code for access token then run migration
 */
router.post('/migrate', auth, async (req, res) => {
    const { code, redirectUri } = req.body;
    const actualRedirectUri = redirectUri || process.env.SPLITWISE_REDIRECT_URI;
    try {
        const tokenResponse = await axios.post('https://secure.splitwise.com/oauth/token', {
            grant_type: 'authorization_code',
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET,
            code,
            redirect_uri: actualRedirectUri
        });
        const accessToken = tokenResponse.data.access_token;
        return runMigration(req.user.id, accessToken, res);
    } catch (err) {
        console.error('[Splitwise OAuth] Token exchange failed:', err.response?.data || err.message);
        return res.status(400).json({ msg: 'OAuth failed — the code may have expired. Please try again.' });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// TOKEN FLOW  (for advanced users / local testing)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @route   POST api/splitwise/migrate-with-token
 * @desc    Migrate using a personal Splitwise API/OAuth token directly
 */
router.post('/migrate-with-token', auth, async (req, res) => {
    const { apiToken } = req.body;
    if (!apiToken || !apiToken.trim()) {
        return res.status(400).json({ msg: 'Splitwise API token is required.' });
    }
    return runMigration(req.user.id, apiToken.trim(), res);
});

// ─────────────────────────────────────────────────────────────────────────────
// SHARED MIGRATION LOGIC
// ─────────────────────────────────────────────────────────────────────────────

async function runMigration(userId, accessToken, res) {
    try {
        console.log(`[Splitwise Migrator] Starting for user ${userId}`);

        // 1. Verify token by fetching current user
        let swCurrentUser;
        try {
            const meResponse = await axios.get('https://secure.splitwise.com/api/v3.0/get_current_user', {
                headers: { Authorization: `Bearer ${accessToken}` }
            });
            swCurrentUser = meResponse.data.user;
            console.log(`[Splitwise Migrator] Verified as: ${swCurrentUser.first_name} ${swCurrentUser.last_name}`);
        } catch (authErr) {
            console.error('[Splitwise Migrator] Token invalid:', authErr.response?.data || authErr.message);
            return res.status(401).json({ msg: 'Invalid Splitwise token. Please check and try again.' });
        }

        // 2. Mark migration as in-progress
        await User.findByIdAndUpdate(userId, {
            splitwiseToken: accessToken,
            splitwiseMigrationStatus: 'pending'
        });

        // 3. Fetch all groups
        const groupsResponse = await axios.get('https://secure.splitwise.com/api/v3.0/get_groups', {
            headers: { Authorization: `Bearer ${accessToken}` }
        });

        const swGroups = groupsResponse.data.groups || [];
        console.log(`[Splitwise Migrator] Found ${swGroups.length} groups.`);

        let processedGroups = 0;
        let totalExpenses = 0;

        // 4. For each group, import expenses
        for (const swGroup of swGroups) {
            const targetName = swGroup.name === 'Non-group' ? 'Splitwise: Individuals' : swGroup.name;
            console.log(`[Splitwise Migrator] Importing group: ${targetName}`);

            let group = await Group.findOne({ name: targetName, members: userId });
            if (!group) {
                group = new Group({
                    name: targetName,
                    members: [userId],
                    createdBy: userId,
                    note: 'Imported from Splitwise'
                });
                await group.save();
            }

            // Fetch up to 500 expenses for this group
            let expensesResponse;
            try {
                const expUrl = swGroup.id === 0
                    ? 'https://secure.splitwise.com/api/v3.0/get_expenses?limit=500'
                    : `https://secure.splitwise.com/api/v3.0/get_expenses?group_id=${swGroup.id}&limit=500`;

                expensesResponse = await axios.get(expUrl, {
                    headers: { Authorization: `Bearer ${accessToken}` }
                });
            } catch (expErr) {
                console.warn(`[Splitwise Migrator] Skipped group ${swGroup.name}:`, expErr.message);
                continue;
            }

            const swExpenses = expensesResponse.data.expenses || [];
            let groupExpenseCount = 0;

            for (const swExp of swExpenses) {
                if (swExp.deleted_at) continue;

                const cost = parseFloat(swExp.cost);
                if (isNaN(cost) || cost === 0) continue;

                // Skip duplicates
                const exists = await Expense.findOne({
                    description: swExp.description || 'Splitwise Migrated',
                    amount: Math.abs(cost),
                    group: group._id,
                    addedBy: userId
                });
                if (exists) continue;

                await new Expense({
                    description: swExp.description || 'Splitwise Migrated',
                    amount: Math.abs(cost),
                    date: swExp.date ? new Date(swExp.date) : new Date(),
                    paidBy: userId,
                    group: group._id,
                    addedBy: userId,
                    splits: [{ user: userId, amount: Math.abs(cost) }]
                }).save();

                groupExpenseCount++;
                totalExpenses++;
            }

            console.log(`[Splitwise Migrator] ✓ ${groupExpenseCount} expenses → "${targetName}"`);
            processedGroups++;
        }

        // 5. Mark done
        await User.findByIdAndUpdate(userId, { splitwiseMigrationStatus: 'completed' });
        console.log(`[Splitwise Migrator] Complete: ${processedGroups} groups, ${totalExpenses} expenses.`);

        return res.json({
            msg: 'Migration successful',
            groupsCount: processedGroups,
            expensesCount: totalExpenses,
            user: swCurrentUser ? `${swCurrentUser.first_name} ${swCurrentUser.last_name}` : 'Unknown'
        });

    } catch (err) {
        console.error('[Splitwise Migrator] FATAL:', err.response?.data || err.message);
        return res.status(500).json({ msg: 'Migration failed: ' + (err.response?.data?.error || err.message) });
    }
}

module.exports = router;
