const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const User = require('../models/User');
const Group = require('../models/Group');
const Expense = require('../models/Expense');

// Initialize Gemini
let genAI;
if (process.env.GEMINI_API_KEY) {
    genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
}

// @route   GET api/ai/suggestions
// @desc    Get personalized suggestions for the AI chat
router.get('/suggestions', auth, async (req, res) => {
    try {
        const context = await getUserContext(req.user.id);
        const suggestions = [];

        // 1. Add/Split example with a friend
        if (context.friends.length > 0) {
            const friend = context.friends[0].username;
            suggestions.push({ text: `Add $50 for Dinner with ${friend}`, icon: "🍕" });
            suggestions.push({ text: `${friend} paid $100 for Groceries`, icon: "🛒" });
        } else {
            suggestions.push({ text: "Add $20 for coffee with a friend", icon: "☕" });
            suggestions.push({ text: "I paid $50 for lunch", icon: "🥙" });
        }

        // 2. Delete example
        suggestions.push({ text: "Delete my last expense", icon: "🗑️" });

        // 3. Group example
        if (context.groups.length > 0) {
            const group = context.groups[0].name;
            suggestions.push({ text: `Check my ${group} balance`, icon: "✈️" });
        } else {
            suggestions.push({ text: "Analyze my spending habits", icon: "📊" });
        }

        res.json(suggestions);
    } catch (err) {
        console.error(err);
        res.status(500).json({ msg: 'Server Error' });
    }
});

// Helper to get user context for AI (including real balances)
async function getUserContext(userId) {
    const user = await User.findById(userId).populate('friends', 'username email');
    const groups = await Group.find({ members: userId }).populate('members', 'username email');
    const recentExpenses = await Expense.find({
        $or: [
            { paidBy: userId },
            { 'splits.user': userId }
        ]
    }).sort({ date: -1 }).limit(10).populate('paidBy', 'username').populate('group', 'name');

    const { convertAmount } = require('../utils/currency');

    // 1. Calculate Friend Balances
    const friendsContext = await Promise.all(user.friends.map(async (friend) => {
        const expenses = await Expense.find({
            group: null,
            $or: [
                { paidBy: userId, 'splits.user': friend._id },
                { paidBy: friend._id, 'splits.user': userId }
            ]
        });

        let balance = 0; 
        expenses.forEach(exp => {
            const isPaidByMe = exp.paidBy.toString() === userId.toString();
            const sourceCurr = exp.currency || 'USD';
            if (isPaidByMe) {
                const friendSplit = exp.splits.find(s => s.user.toString() === friend._id.toString());
                if (friendSplit) balance += convertAmount(friendSplit.amount, sourceCurr, 'USD');
            } else {
                const mySplit = exp.splits.find(s => s.user.toString() === userId.toString());
                if (mySplit) balance -= convertAmount(mySplit.amount, sourceCurr, 'USD');
            }
        });

        return { id: friend._id, username: friend.username, netBalance: balance.toFixed(2) };
    }));

    // 2. Calculate Group Balances (from user's perspective)
    const groupsContext = await Promise.all(groups.map(async (group) => {
        const expenses = await Expense.find({ group: group._id });
        let userBalance = 0;

        expenses.forEach(exp => {
            const payerId = exp.paidBy.toString();
            const sourceCurr = exp.currency || 'USD';
            
            // If I paid, I'm owed the sum of others' splits
            if (payerId === userId.toString()) {
                exp.splits.forEach(split => {
                    if (split.user.toString() !== userId.toString()) {
                        userBalance += convertAmount(split.amount, sourceCurr, 'USD');
                    }
                });
            } else {
                // If someone else paid, I owe my split
                const mySplit = exp.splits.find(s => s.user.toString() === userId.toString());
                if (mySplit) {
                    userBalance -= convertAmount(mySplit.amount, sourceCurr, 'USD');
                }
            }
        });

        return { 
            id: group._id, 
            name: group.name, 
            myNetBalanceInGroup: userBalance.toFixed(2),
            members: group.members.map(m => ({ id: m._id, username: m.username }))
        };
    }));

    return {
        user: { username: user.username, email: user.email },
        friends: friendsContext,
        groups: groupsContext,
        recentExpenses: recentExpenses.map(e => ({
            id: e._id,
            description: e.description,
            amount: e.amount,
            date: e.date,
            paidBy: e.paidBy.username,
            group: e.group ? e.group.name : 'Individual'
        }))
    };
}

// @route   POST api/ai/chat
// @desc    Chat with Paywise AI
router.post('/chat', auth, async (req, res) => {
    try {
        const { message } = req.body;
        if (!genAI) {
            return res.status(500).json({ msg: 'AI service not configured on server' });
        }

        const context = await getUserContext(req.user.id);
        const userId = req.user.id;
        
        const prompt = `
            You are "Paywise AI", the master financial strategist for the Paywise app.
            
            Current User: ${context.user.username}
            User's Friends & Balances: ${JSON.stringify(context.friends || [])} (netBalance > 0 means they owe user, < 0 means user owes them)
            User's Groups & Balances: ${JSON.stringify(context.groups || [])} (myNetBalanceInGroup is the user's total stake)
            Recent Activity: ${JSON.stringify(context.recentExpenses || [])}
            Current Date: ${new Date().toLocaleDateString()}
            Base Currency: USD

            YOUR CAPABILITIES:
            1. BALANCE CHECK: Answer questions like "What do I owe Suzz?" or "Who owes me money?". Use the provided balances.
            2. ADD EXPENSE: Propose adding new expenses based on conversations. Identify description, amount, recipientType, recipientId, participants, splitMethod, and paidBy.
            3. DELETE EXPENSE: Identify and propose deleting recent transactions.
            4. ADVICE: Give witty, helpful financial tips based on spending.

            ACTION PROTOCOL:
            If adding an expense:
            - type: "ADD_EXPENSE"
            - Default paidBy to "${userId}" unless specified otherwise.
            - If user says "Paid $20 for coffee with Suzz", default recipientId to Suzz's ID, participants: ["${userId}", Suzz's ID].
            
            CRITICAL RULES:
            - ALWAYS generate the [ACTION] block if the user's intent is clear.
            - If a friend owes money (netBalance > 0), be encouraging. If user owes (netBalance < 0), be subtle.
            - The CURRENT USER'S ID is: "${userId}"

            Response Format:
            - Provide a brief helpful/witty text.
            - Follow it IMMEDIATELY with the JSON action block: [ACTION]{...}[/ACTION].

            User Message: "${message}"
        `;

        const modelsToTry = [
            "gemini-2.5-flash",
            "gemini-2.5-pro",
            "gemini-2.0-flash",
            "gemini-flash-latest",
            "gemini-pro-latest"
        ];
        let result;
        let lastErr;

        for (const modelName of modelsToTry) {
            try {
                const model = genAI.getGenerativeModel({ model: modelName });
                const response = await Promise.race([
                    model.generateContent(prompt),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 20000))
                ]);
                
                if (response && response.response) {
                    result = response;
                    break;
                }
            } catch (err) {
                console.warn(`AI attempt with ${modelName} failed:`, err.message);
                lastErr = err;
            }
        }

        if (!result) throw new Error("All AI models failed to respond");

        const responseText = result.response.text();

        // Analytics Tracking (Safe)
        try {
            const trackMetric = require('../utils/analyticsTracker');
            const { usageMetadata } = result.response;
            await trackMetric('aiRequests', 1);
            if (usageMetadata) {
                await trackMetric('aiInputTokens', usageMetadata.promptTokenCount || 0);
                await trackMetric('aiOutputTokens', usageMetadata.candidatesTokenCount || 0);
            }
        } catch (e) {}

        res.json({ reply: responseText });
    } catch (err) {
        console.error('AI Processing Error:', err.message);
        res.json({ 
            reply: "My brain is taking a quick power nap! (AI service is currently saturated). ⚡\n\nI couldn't process that request right now, but you can try again in a few seconds." 
        });
    }
});

module.exports = router;
