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

// Helper to get user context for AI
async function getUserContext(userId) {
    const user = await User.findById(userId).populate('friends', 'username email');
    const groups = await Group.find({ members: userId }).populate('members', 'username email');
    const recentExpenses = await Expense.find({
        $or: [
            { paidBy: userId },
            { 'splits.user': userId }
        ]
    }).sort({ date: -1 }).limit(5).populate('paidBy', 'username').populate('group', 'name');

    return {
        user: { username: user.username, email: user.email },
        friends: user.friends.map(f => ({ id: f._id, username: f.username })),
        groups: groups.map(g => ({ 
            id: g._id, 
            name: g.name, 
            members: g.members.map(m => ({ id: m._id, username: m.username }))
        })),
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
            You are "Paywise AI", a helpful financial assistant for the Paywise app.
            
            Current User: ${context.user.username}
            User's Friends: ${JSON.stringify(context.friends)}
            User's Groups: ${JSON.stringify(context.groups)}
            Recent Activity: ${JSON.stringify(context.recentExpenses)}
            Current Date: ${new Date().toLocaleDateString()}

            YOUR CAPABILITIES:
            1. Answer questions about spending habits.
            2. Suggest adding expenses.
            3. Identify friends or groups from user messages.
            4. Delete recent expenses if requested.

            ACTION PROTOCOL:
            If the user wants to add an expense, you MUST identify:
            - type: "ADD_EXPENSE"
            - description, amount, recipientType, recipientId, participants, splitMethod
            - paidBy (The ID of the person who paid. If the user says "Suzz paid", use Suzz's ID. If not mentioned, default to "${userId}")

            If the user wants to delete an expense (e.g., "Delete the $255 expense"), look for a match in "Recent Activity" and identify:
            - type: "DELETE_EXPENSE"
            - expenseId (the ID of the matching expense)
            - description (the description from the activity list)
            - amount (the amount from the activity list)

            CRITICAL RULES:
            - If you have an amount and a recipient (friend or group), you MUST generate the [ACTION] block immediately. Do not ask for more details first.
            - If the user specifies "food", use "Food" as the description.
            - The CURRENT USER'S ID is: "${userId}"

            Response Format:
            - Provide a brief helpful text.
            - Follow it IMMEDIATELY with the JSON action block: [ACTION]{...}[/ACTION].

            Example Add Action:
            [ACTION]
            {
                "type": "ADD_EXPENSE",
                "data": {
                    "description": "Lunch",
                    "amount": 25,
                    "recipientType": "friend",
                    "recipientId": "123...",
                    "paidBy": "123...",
                    "participants": ["${userId}", "123..."],
                    "splitMethod": "equally"
                }
            }
            [/ACTION]

            Example Delete Action:
            [ACTION]
            {
                "type": "DELETE_EXPENSE",
                "data": {
                    "expenseId": "67b...",
                    "description": "Food split",
                    "amount": 255
                }
            }
            [/ACTION]

            User Message: "${message}"
        `;

        // Try multiple models in case one is busy or missing
        const modelsToTry = [
            "gemini-2.5-flash",
            "gemini-2.0-flash",
            "gemini-1.5-flash-latest",
            "gemini-1.5-flash",
            "gemini-1.5-pro"
        ];
        let result;
        let lastErr;

        for (const modelName of modelsToTry) {
            try {
                const model = genAI.getGenerativeModel({ model: modelName });
                // Add a timeout/race to prevent hanging
                const response = await Promise.race([
                    model.generateContent(prompt),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 8000))
                ]);
                
                if (response) {
                    result = response;
                    break;
                }
            } catch (err) {
                console.warn(`AI model ${modelName} failed, trying next...`);
                lastErr = err;
                // Tiny delay before next attempt if it was a rate limit
                if (err.status === 429 || err.status === 503) {
                    await new Promise(r => setTimeout(r, 500));
                }
            }
        }

        // --- PRODUCTION FALLBACK PROTECTION ---
        // If all models fail, we return a friendly message instead of a 500/JSON error
        if (!result) {
            console.error('All AI models failed. Sending friendly fallback.');
            return res.json({ 
                reply: "I'm sorry, I'm taking a quick power nap to stay sharp! ⚡\n\nI couldn't process that request right now, but you can try again in a few seconds or use the 'Add Expense' button on your dashboard to do it manually. I'll be back shortly!" 
            });
        }
        
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
        console.error('Critical AI Failure:', err);
        // Absolute last resort fallback
        res.json({ 
            reply: "I'm having a bit of trouble connecting to my brain right now. Please try again in 10 seconds!" 
        });
    }
});

module.exports = router;
