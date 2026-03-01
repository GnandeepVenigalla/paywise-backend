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

        // Helper: find an existing Paywise user or create a ghost account for a Splitwise member
        const getOrCreatePaywiseUser = async (swMember) => {
            if (!swMember || !swMember.email) return null;
            const email = swMember.email.toLowerCase();
            let paywiseUser = await User.findOne({ email });
            if (!paywiseUser) {
                const firstName = swMember.first_name || '';
                const lastName = swMember.last_name || '';
                const fullName = `${firstName} ${lastName}`.trim() || email.split('@')[0];
                // Make username unique
                let username = fullName.replace(/\s+/g, '_').toLowerCase();
                const existing = await User.findOne({ username });
                if (existing) username = username + '_' + Date.now().toString().slice(-4);

                paywiseUser = new User({
                    email,
                    username,
                    password: 'GHOST_' + Math.random().toString(36), // unusable placeholder
                    isGhostUser: true,
                    avatarInitials: (firstName[0] || '') + (lastName[0] || '')
                });
                await paywiseUser.save();
                console.log(`[Splitwise Migrator]   Created ghost user for ${email}`);
            }
            return paywiseUser;
        };

        // 4. For each group, import expenses with full member & split data
        for (const swGroup of swGroups) {
            const targetName = swGroup.name === 'Non-group' ? 'Splitwise: Individuals' : swGroup.name;
            console.log(`[Splitwise Migrator] Importing group: ${targetName}`);

            // 4a. Build a splitwise_user_id → paywise_user_id map for ALL group members
            const memberMap = {}; // { splitwiseId: paywiseMongoId }
            memberMap[swCurrentUser.id] = userId;

            const groupMembers = swGroup.members || [];
            const paywiseMemberIds = [userId];

            for (const swMember of groupMembers) {
                if (memberMap[swMember.id]) continue;
                const paywiseUser = await getOrCreatePaywiseUser(swMember);
                if (paywiseUser) {
                    memberMap[swMember.id] = paywiseUser._id;
                    const midStr = paywiseUser._id.toString();
                    if (!paywiseMemberIds.map(m => m.toString()).includes(midStr)) {
                        paywiseMemberIds.push(paywiseUser._id);
                    }
                }
            }

            // 4b. Find or create group with all matched members
            let group = await Group.findOne({ name: targetName, members: userId });
            if (!group) {
                group = new Group({
                    name: targetName,
                    members: paywiseMemberIds,
                    createdBy: userId,
                    note: 'Imported from Splitwise'
                });
            } else {
                // Add newly matched members if not already in group
                for (const mid of paywiseMemberIds) {
                    if (!group.members.map(m => m.toString()).includes(mid.toString())) {
                        group.members.push(mid);
                    }
                }
            }
            await group.save();

            // 4c. Fetch ALL expenses with pagination
            let allSwExpenses = [];
            let offset = 0;
            const PAGE = 200;
            while (true) {
                let expUrl = swGroup.id === 0
                    ? `https://secure.splitwise.com/api/v3.0/get_expenses?limit=${PAGE}&offset=${offset}`
                    : `https://secure.splitwise.com/api/v3.0/get_expenses?group_id=${swGroup.id}&limit=${PAGE}&offset=${offset}`;
                try {
                    const resp = await axios.get(expUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
                    const batch = resp.data.expenses || [];
                    allSwExpenses = allSwExpenses.concat(batch);
                    if (batch.length < PAGE) break;
                    offset += PAGE;
                } catch (e) {
                    console.warn(`[Splitwise Migrator] Pagination error for ${targetName}:`, e.message);
                    break;
                }
            }
            console.log(`[Splitwise Migrator]   ${allSwExpenses.length} total expenses fetched for "${targetName}"`);

            let groupExpenseCount = 0;

            for (const swExp of allSwExpenses) {
                if (swExp.deleted_at) continue;

                const cost = parseFloat(swExp.cost);
                if (isNaN(cost) || cost === 0) continue;

                // Determine who paid (use mapped paywise user, fallback to current user)
                const swUsers = swExp.users || [];
                const payer = swUsers.find(u => parseFloat(u.paid_share || 0) > 0);
                const swPayerId = payer ? payer.user_id : swCurrentUser.id;
                const paywisePaidBy = memberMap[swPayerId] || userId;

                // Build splits for all members who owe money
                const splits = [];
                for (const u of swUsers) {
                    const owedShare = parseFloat(u.owed_share || 0);
                    if (owedShare <= 0) continue;
                    const paywiseId = memberMap[u.user_id];
                    if (!paywiseId) continue; // skip non-Paywise users
                    splits.push({ user: paywiseId, amount: owedShare });
                }

                // If no splits resolved (all non-Paywise users), use full amount on current user
                if (splits.length === 0) {
                    splits.push({ user: userId, amount: Math.abs(cost) });
                }

                // Duplicate check
                const exists = await Expense.findOne({
                    description: swExp.description || 'Splitwise Migrated',
                    amount: Math.abs(cost),
                    date: swExp.date ? new Date(swExp.date) : undefined,
                    group: group._id
                });
                if (exists) continue;

                await new Expense({
                    description: swExp.description || 'Splitwise Migrated',
                    amount: Math.abs(cost),
                    date: swExp.date ? new Date(swExp.date) : new Date(),
                    paidBy: paywisePaidBy,
                    group: group._id,
                    addedBy: userId,
                    splits
                }).save();

                groupExpenseCount++;
                totalExpenses++;
            }

            console.log(`[Splitwise Migrator] ✓ ${groupExpenseCount} expenses → "${targetName}"`);
            processedGroups++;
        }

        // 5. Match Splitwise friends to Paywise users
        let friendsAdded = 0;
        try {
            const friendsResponse = await axios.get('https://secure.splitwise.com/api/v3.0/get_friends', {
                headers: { Authorization: `Bearer ${accessToken}` }
            });
            const swFriends = friendsResponse.data.friends || [];
            console.log(`[Splitwise Migrator] Found ${swFriends.length} Splitwise friends to match.`);

            const currentUser = await User.findById(userId);
            for (const swFriend of swFriends) {
                if (!swFriend.email) continue;
                if (swFriend.id === swCurrentUser.id) continue;

                // Find or create a Paywise user for this Splitwise friend
                const paywiseUser = await getOrCreatePaywiseUser(swFriend);
                if (!paywiseUser) continue;
                if (paywiseUser._id.toString() === userId.toString()) continue;

                // Add as mutual friends if not already
                const cuFriends = currentUser.friends.map(f => f.toString());
                if (!cuFriends.includes(paywiseUser._id.toString())) {
                    currentUser.friends.push(paywiseUser._id);
                }
                const theirFriends = paywiseUser.friends.map(f => f.toString());
                if (!theirFriends.includes(userId.toString())) {
                    paywiseUser.friends.push(userId);
                    await paywiseUser.save();
                }
                friendsAdded++;
                console.log(`[Splitwise Migrator] ✓ Friend added: ${swFriend.email}`);
            }
            await currentUser.save();
        } catch (friendErr) {
            console.warn('[Splitwise Migrator] Friend step error:', friendErr.message);
        }

        // 6. Mark done
        await User.findByIdAndUpdate(userId, { splitwiseMigrationStatus: 'completed' });
        console.log(`[Splitwise Migrator] Complete: ${processedGroups} groups, ${totalExpenses} expenses, ${friendsAdded} friends.`);

        return res.json({
            msg: 'Migration successful',
            groupsCount: processedGroups,
            expensesCount: totalExpenses,
            friendsCount: friendsAdded,
            user: swCurrentUser ? `${swCurrentUser.first_name} ${swCurrentUser.last_name}` : 'Unknown'
        });

    } catch (err) {
        console.error('[Splitwise Migrator] FATAL:', err.response?.data || err.message);
        return res.status(500).json({ msg: 'Migration failed: ' + (err.response?.data?.error || err.message) });
    }
}

module.exports = router;
