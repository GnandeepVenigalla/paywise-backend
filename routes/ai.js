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

        return { id: friend._id.toString(), username: friend.username, netBalance: balance.toFixed(2) };
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
            id: group._id.toString(), 
            name: group.name, 
            myNetBalanceInGroup: userBalance.toFixed(2),
            members: group.members.map(m => ({ id: m._id.toString(), username: m.username }))
        };
    }));

    return {
        user: { username: user.username, email: user.email },
        friends: friendsContext,
        groups: groupsContext,
        recentExpenses: recentExpenses.map(e => ({
            id: e._id.toString(),
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

        // Build a concise friends reference so AI can use real IDs
        const friendsRef = context.friends.map(f =>
            `  - "${f.username}" (id: "${f.id}", balance: $${f.netBalance} USD; positive = they owe you, negative = you owe them)`
        ).join('\n') || '  (no friends yet)';

        const groupsRef = context.groups.map(g =>
            `  - "${g.name}" (id: "${g.id}", your net: $${g.myNetBalanceInGroup} USD, members: ${g.members.map(m => `${m.username}(${m.id})`).join(', ')})`
        ).join('\n') || '  (no groups yet)';

        const expensesRef = context.recentExpenses.map(e =>
            `  - id:"${e.id}" | "${e.description}" $${e.amount} on ${new Date(e.date).toLocaleDateString()} | paid by: ${e.paidBy} | context: ${e.group}`
        ).join('\n') || '  (no recent expenses)';

        const prompt = `You are "Paywise AI", a smart financial assistant for the Paywise expense-splitting app.

CURRENT USER: ${context.user.username} (id: "${userId}")

FRIENDS & BALANCES:
${friendsRef}

GROUPS & BALANCES:
${groupsRef}

RECENT EXPENSES (last 10):
${expensesRef}

TODAY: ${new Date().toLocaleDateString()}

== YOUR CAPABILITIES ==
You can understand natural language and perform these actions:

1. ADD_EXPENSE (friend expense): "I paid $50 for dinner with John"
2. GROUP_EXPENSE: "Add $100 for hotel in Trip group"  
3. DELETE_EXPENSE: "Delete my last expense" or "Remove the $50 dinner"
4. SETTLE_UP: "Settle up with John" or "Mark John as paid"
5. INFO_ONLY: Balance questions, advice, spending analysis — no action needed

== STRICT RESPONSE FORMAT ==

Always respond with:
1. A short, friendly message (1-3 sentences max)
2. If action needed, IMMEDIATELY follow with the JSON action block

For ADD_EXPENSE (1:1 friend expense):
[ACTION]
{
  "type": "ADD_EXPENSE",
  "description": "Dinner at restaurant",
  "amount": 50,
  "currency": "USD",
  "paidById": "${userId}",
  "friendId": "<use exact id from FRIENDS list above>",
  "splitMethod": "equally",
  "splits": [
    { "userId": "${userId}", "amount": 25 },
    { "userId": "<friendId>", "amount": 25 }
  ]
}
[/ACTION]

For GROUP_EXPENSE:
[ACTION]
{
  "type": "GROUP_EXPENSE",
  "description": "Hotel booking",
  "amount": 100,
  "currency": "USD",
  "paidById": "${userId}",
  "groupId": "<use exact id from GROUPS list above>",
  "splits": [
    { "userId": "<memberId>", "amount": <share> }
  ]
}
[/ACTION]

For DELETE_EXPENSE:
[ACTION]
{
  "type": "DELETE_EXPENSE",
  "expenseId": "<use exact id from RECENT EXPENSES list>",
  "description": "<expense description>",
  "amount": <amount>
}
[/ACTION]

For SETTLE_UP:
[ACTION]
{
  "type": "SETTLE_UP",
  "friendId": "<use exact id from FRIENDS list>",
  "friendName": "<friend username>",
  "amount": <balance amount as positive number>,
  "payerId": "<who is paying — current user or friend id>"
}
[/ACTION]

For INFO_ONLY (no action):
[ACTION]
{
  "type": "INFO_ONLY"
}
[/ACTION]

== RULES ==
- ALWAYS include an [ACTION] block — even for info-only responses.
- Use REAL IDs from the data above. Never use placeholder IDs.
- For ADD_EXPENSE, split equally between paidById and friendId unless user specifies otherwise.
- If amount is not clear, ask the user.
- If friend/group name is ambiguous, ask which one.
- Keep text response short — max 2-3 sentences. Be friendly and witty.
- Do NOT add expense twice or confirm twice.

USER MESSAGE: "${message}"`;

        const modelsToTry = [
            "gemini-2.5-flash-preview-04-17",
            "gemini-2.0-flash",
            "gemini-1.5-flash",
            "gemini-pro"
        ];
        let result;
        let lastErr;

        for (const modelName of modelsToTry) {
            try {
                const model = genAI.getGenerativeModel({ model: modelName });
                const response = await Promise.race([
                    model.generateContent(prompt),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 25000))
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

        // Parse the action block
        const actionMatch = responseText.match(/\[ACTION\]([\s\S]*?)\[\/ACTION\]/);
        let actionData = null;
        if (actionMatch) {
            try {
                // Strip markdown code fences if present
                const raw = actionMatch[1].replace(/```json|```/g, '').trim();
                actionData = JSON.parse(raw);
            } catch (e) {
                console.warn('[AI] Failed to parse action JSON:', e.message);
            }
        }

        const cleanedReply = responseText.replace(/\[ACTION\][\s\S]*?\[\/ACTION\]/, '').trim() || "Done!";

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

        res.json({ reply: cleanedReply, action: actionData });
    } catch (err) {
        console.error('AI Processing Error:', err.message);
        res.json({ 
            reply: "My brain is taking a quick power nap! ⚡ " + err.message,
            action: null
        });
    }
});

module.exports = router;
