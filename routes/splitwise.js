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
        console.log(`[Splitwise Migrator] Starting global migration for user ${userId}`);

        // 1. Verify token & get current user info
        const meResponse = await axios.get('https://secure.splitwise.com/api/v3.0/get_current_user', {
            headers: { Authorization: `Bearer ${accessToken}` }
        });
        const swCurrentUser = meResponse.data.user;
        const swCurrentUserId = swCurrentUser.id;

        // 2. Mark migration as in-progress
        await User.findByIdAndUpdate(userId, {
            splitwiseToken: accessToken,
            splitwiseMigrationStatus: 'pending'
        });

        // 3. Map Splitwise Groups to Paywise Groups
        const groupsResponse = await axios.get('https://secure.splitwise.com/api/v3.0/get_groups', {
            headers: { Authorization: `Bearer ${accessToken}` }
        });
        const swGroups = groupsResponse.data.groups || [];
        const groupMapping = {}; // sw_group_id -> paywise_group_id
        const globalMemberMap = {}; // sw_user_id -> paywise_user_id
        globalMemberMap[swCurrentUserId] = userId;

        const getOrCreatePaywiseUser = async (swMember) => {
            if (!swMember) return null;
            const swId = swMember.user_id || swMember.id;
            if (globalMemberMap[swId]) return globalMemberMap[swId];

            const email = (swMember.email || `sw_${swId}@splitwise.com`).toLowerCase();
            let paywiseUser = await User.findOne({ email });
            if (!paywiseUser) {
                const firstName = swMember.first_name || '';
                const lastName = swMember.last_name || '';
                const fullName = `${firstName} ${lastName}`.trim() || email.split('@')[0];
                let username = fullName.replace(/\s+/g, '_').toLowerCase();
                const existing = await User.findOne({ username });
                if (existing) username = username + '_' + Date.now().toString().slice(-4);

                paywiseUser = new User({
                    email,
                    username,
                    password: 'GHOST_' + Math.random().toString(36),
                    isGhostUser: true,
                    avatarInitials: (firstName[0] || '') + (lastName[0] || '')
                });
                await paywiseUser.save();
            }
            globalMemberMap[swId] = paywiseUser._id;
            return paywiseUser._id;
        };

        for (const swGroup of swGroups) {
            if (swGroup.id === 0) continue; // Skip Non-group in group mapping

            // Ensure all group members have Paywise IDs
            const paywiseMemberIds = [userId];
            for (const swMember of (swGroup.members || [])) {
                const pid = await getOrCreatePaywiseUser(swMember);
                if (pid && !paywiseMemberIds.some(id => id.toString() === pid.toString())) {
                    paywiseMemberIds.push(pid);
                }
            }

            let group = await Group.findOne({ name: swGroup.name, members: userId });
            if (!group) {
                group = new Group({
                    name: swGroup.name,
                    members: paywiseMemberIds,
                    createdBy: userId,
                    note: 'Imported from Splitwise'
                });
            } else {
                for (const mid of paywiseMemberIds) {
                    if (!group.members.some(id => id.toString() === mid.toString())) {
                        group.members.push(mid);
                    }
                }
            }
            await group.save();
            groupMapping[swGroup.id] = group._id;
        }

        // 4. Fetch ALL expenses (including non-group)
        let allSwExpenses = [];
        let offset = 0;
        const PAGE = 200;
        while (true) {
            try {
                const resp = await axios.get(`https://secure.splitwise.com/api/v3.0/get_expenses?limit=${PAGE}&offset=${offset}`, {
                    headers: { Authorization: `Bearer ${accessToken}` }
                });
                const batch = resp.data.expenses || [];
                allSwExpenses = allSwExpenses.concat(batch);
                if (batch.length < PAGE) break;
                offset += PAGE;
            } catch (e) {
                console.warn(`[Splitwise Migrator] Pagination error:`, e.message);
                break;
            }
        }
        console.log(`[Splitwise Migrator] Processing ${allSwExpenses.length} total fetched expenses.`);

        let insertedCount = 0;
        for (const swExp of allSwExpenses) {
            if (swExp.deleted_at) continue;
            const cost = parseFloat(swExp.cost);
            if (isNaN(cost) || cost === 0) continue;

            const targetGroupId = swExp.group_id ? groupMapping[swExp.group_id] : null;

            // Duplicate Check
            const existingExp = await Expense.findOne({
                description: swExp.description || 'Splitwise Migrated',
                amount: Math.abs(cost),
                date: swExp.date ? new Date(swExp.date) : undefined,
                group: targetGroupId
            });
            if (existingExp) continue;

            // Resolve participants for THIS expense
            const swParticipants = swExp.users || [];
            const splits = [];
            let paywisePaidBy = userId;

            for (const participant of swParticipants) {
                const pid = await getOrCreatePaywiseUser(participant);
                if (!pid) continue;

                if (parseFloat(participant.paid_share || 0) > 0) {
                    paywisePaidBy = pid;
                }

                const owed = parseFloat(participant.owed_share || 0);
                if (owed > 0) {
                    splits.push({ user: pid, amount: owed });
                }
            }

            if (splits.length === 0) continue; // Skip if no valid splits found

            await new Expense({
                description: swExp.description || 'Splitwise Migrated',
                amount: Math.abs(cost),
                currency: swExp.currency_code || 'USD',
                date: swExp.date ? new Date(swExp.date) : new Date(),
                paidBy: paywisePaidBy,
                group: targetGroupId,
                addedBy: userId,
                splits
            }).save();
            insertedCount++;
        }

        // 5. Match Friends (ensure all Splitwise friends are Paywise friends)
        try {
            const friendsResponse = await axios.get('https://secure.splitwise.com/api/v3.0/get_friends', {
                headers: { Authorization: `Bearer ${accessToken}` }
            });
            const swFriends = (friendsResponse.data.friends || []).filter(fs => fs.id !== swCurrentUserId);
            const currentUser = await User.findById(userId);

            for (const swf of swFriends) {
                const pid = await getOrCreatePaywiseUser(swf);
                if (!pid) continue;

                if (!currentUser.friends.some(f => f.toString() === pid.toString())) {
                    currentUser.friends.push(pid);
                }
                // reciprocal check
                const friendUser = await User.findById(pid);
                if (friendUser && !friendUser.friends.some(f => f.toString() === userId.toString())) {
                    friendUser.friends.push(userId);
                    await friendUser.save();
                }
            }
            await currentUser.save();
        } catch (fe) {
            console.warn('[Splitwise Migrator] Friend sync warning:', fe.message);
        }

        await User.findByIdAndUpdate(userId, { splitwiseMigrationStatus: 'completed' });
        console.log(`[Splitwise Migrator] DONE. Processed ${insertedCount} new expenses.`);

        return res.json({
            msg: 'Migration successful',
            expensesCount: insertedCount,
            groupsCount: Object.keys(groupMapping).length,
            user: `${swCurrentUser.first_name} ${swCurrentUser.last_name}`
        });

    } catch (err) {
        console.error('[Splitwise Migrator] Logic Error:', err.response?.data || err.message);
        return res.status(500).json({ msg: 'Migration failed to process correctly.' });
    }
}

module.exports = router;
