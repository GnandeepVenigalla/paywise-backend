const express = require('express');
const router = express.Router();
const Expense = require('../models/Expense');
const auth = require('../middleware/auth');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const logActivity = require('../utils/activityLogger');

// @route   POST api/expenses
// @desc    Add an expense
router.post('/', auth, async (req, res) => {
    try {
        const { description, amount, currency, group, paidBy, splits, items } = req.body;
        const User = require('../models/User');
        const { getCurrencySymbol } = require('../utils/currency');

        // Check if any participant has blocked the other
        const currentUser = await User.findById(req.user.id);
        const participantIds = [...new Set([(paidBy || req.user.id).toString(), ...(splits || []).map(s => (s.user._id || s.user).toString())])];

        for (const pId of participantIds) {
            if (pId === req.user.id) continue;
            const otherUser = await User.findById(pId);
            if (otherUser && (otherUser.blockedUsers.includes(req.user.id) || currentUser.blockedUsers.includes(pId))) {
                return res.status(403).json({ msg: 'Cannot add expense involving a blocked user.' });
            }
        }

        const newExpense = new Expense({
            description,
            amount,
            currency: currency || 'USD',
            group: group || null,
            paidBy: paidBy || req.user.id,
            addedBy: req.user.id,
            splits,
            items: items || []
        });

        let expense = await newExpense.save();
        expense = await expense.populate([
            { path: 'paidBy', select: 'username email' },
            { path: 'splits.user', select: 'username email' },
            { path: 'items.assignedTo', select: 'username email' }
        ]);

        const sym = getCurrencySymbol(currency || 'USD');
        await logActivity({
            user: req.user.id,
            action: `New expense recorded: "${description}" (${sym}${amount})`,
            category: 'expense',
            status: 'success'
        });

        res.json(expense);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   GET api/expenses/user/:id
// @desc    Get all expenses involving a user directly (not group)
router.get('/individual', auth, async (req, res) => {
    try {
        // user is involved either as paidBy or in splits
        const expenses = await Expense.find({
            group: null,
            $or: [
                { paidBy: req.user.id },
                { 'splits.user': req.user.id }
            ]
        }).populate('paidBy', 'username email').populate('splits.user', 'username email');

        res.json(expenses);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   GET api/expenses/friends/:friendId
// @desc    Get all expenses between current user and friend
router.get('/friends/:friendId', auth, async (req, res) => {
    try {
        const User = require('../models/User');
        const friend = await User.findById(req.params.friendId).select('-password');

        if (!friend) {
            return res.status(404).json({ msg: 'Friend not found' });
        }

        const expenses = await Expense.find({
            $or: [
                { paidBy: req.user.id, 'splits.user': friend._id },
                { paidBy: friend._id, 'splits.user': req.user.id }
            ]
        })
            .sort({ date: -1 })
            .populate('group', 'name')
            .populate('paidBy', 'username email')
            .populate('addedBy', 'username email')
            .populate('splits.user', 'username email');

        const { convertAmount } = require('../utils/currency');
        let balance = 0;
        expenses.forEach(exp => {
            const isPaidByMe = exp.paidBy._id.toString() === req.user.id;
            const sourceCurr = exp.currency || 'USD';
            if (isPaidByMe) {
                const fSplit = exp.splits.find(s => s.user._id.toString() === friend._id.toString());
                if (fSplit) {
                    balance += convertAmount(fSplit.amount, sourceCurr, 'USD');
                }
            } else {
                const mySplit = exp.splits.find(s => s.user._id.toString() === req.user.id);
                if (mySplit) {
                    balance -= convertAmount(mySplit.amount, sourceCurr, 'USD');
                }
            }
        });

        res.json({ friend, expenses, balance });
    } catch (err) {
        console.error(err.message);
        if (err.kind === 'ObjectId') {
            return res.status(404).json({ msg: 'Friend not found' });
        }
        res.status(500).send('Server Error');
    }
});

// @route   POST api/expenses/scan
// @desc    Use Google Gemini to scan a receipt securely
router.post('/scan', auth, async (req, res) => {
    try {
        const { imageBase64 } = req.body;

        if (!process.env.GEMINI_API_KEY) {
            return res.status(400).json({ msg: 'GEMINI_API_KEY not found in backend .env' });
        }

        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        // Using the ultra-fast flash model which works universally for vision tasks
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

        // Extract the correct mimeType and base64 string
        const mimeMatch = imageBase64.match(/^data:(image\/\w+);base64,/);
        const mimeType = mimeMatch ? mimeMatch[1] : "image/jpeg";
        const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, "");

        const prompt = `
            Analyze this receipt image from a Global perspective. 
            Extract EVERY individual line item purchased, including their clean names and precise prices.
            
            CRITICAL - DISCOUNT HANDLING:
            - Look for discounts, coupons, or rebates (often shown with a minus sign like "4.00-" or "-4.00").
            - You MUST subtract these discounts from the item they belong to. 
            - For example, if you see "Polo Shirt 16.99" followed by "Discount 4.00-", you should return ONE item: "Polo Shirt" with price 12.99.
            - Do not list discounts as separate items unless you cannot identify the parent item.
            
            CRITICAL - TAXES:
            - You MUST detect and extract all additional fees, taxes, and surcharges using their localized names (GST, IVA, VAT, Tax, etc.).
            - These SHOULD be separate line items.
            
            Format your response STRICTLY as a JSON array of objects with "name" and "price" (number). 
            Example output format EXACTLY:
            [ 
              {"name": "Item A", "price": 12.99}, (Result of 16.99 - 4.00 discount)
              {"name": "IVA @21%", "price": 15.60},
              {"name": "Service Charge", "price": 12.00}
            ]
        `;

        const result = await model.generateContent([
            prompt,
            {
                inlineData: {
                    data: base64Data,
                    mimeType: mimeType
                }
            }
        ]);

        let responseText = result.response.text();
        // Remove markdown JSON formatting if necessary
        responseText = responseText.replace(/```json/gi, '').replace(/```/gi, '').trim();

        const extractedItems = JSON.parse(responseText);

        res.json({ items: extractedItems });

    } catch (err) {
        console.error(err);
        res.status(500).json({ msg: 'Failed to scan receipt with AI. Ensure image is clear.' });
    }
});

// @route   DELETE api/expenses/:id
// @desc    Delete an expense
router.delete('/:id', auth, async (req, res) => {
    try {
        const expense = await Expense.findById(req.params.id);

        if (!expense) {
            return res.status(404).json({ msg: 'Expense not found' });
        }

        // Only allow the person who created/uploaded it to delete it
        const isUploader = expense.addedBy ? expense.addedBy.toString() === req.user.id : expense.paidBy.toString() === req.user.id;

        if (!isUploader) {
            return res.status(401).json({ msg: 'Only the person who uploaded this expense can delete it' });
        }

        await expense.deleteOne();

        res.json({ msg: 'Expense removed' });
    } catch (err) {
        console.error(err.message);
        if (err.kind === 'ObjectId') {
            return res.status(404).json({ msg: 'Expense not found' });
        }
        res.status(500).send('Server Error');
    }
});

// @route   PUT api/expenses/:id
// @desc    Update an expense
router.put('/:id', auth, async (req, res) => {
    try {
        const expense = await Expense.findById(req.params.id);

        if (!expense) {
            return res.status(404).json({ msg: 'Expense not found' });
        }

        // Only allow the person who created/uploaded it to edit it
        const isUploader = expense.addedBy ? expense.addedBy.toString() === req.user.id : expense.paidBy.toString() === req.user.id;

        if (!isUploader) {
            return res.status(401).json({ msg: 'Only the person who uploaded this expense can edit it' });
        }

        const { description, amount, currency, splits, items } = req.body;

        if (description) expense.description = description;
        if (currency) expense.currency = currency;

        if (amount && Number(amount) !== expense.amount) {
            const newAmount = Number(amount);
            // Proportionalize the splits and items only if they are not explicitly provided in this request
            if (!splits && expense.amount > 0) {
                const ratio = newAmount / expense.amount;
                expense.splits = expense.splits.map(split => ({
                    user: split.user,
                    amount: split.amount * ratio
                }));
                // Also proportionalize items if any
                if (expense.items && expense.items.length > 0) {
                    expense.items = expense.items.map(item => ({
                        ...item.toObject(),
                        price: item.price * ratio
                    }));
                }
            }
            expense.amount = newAmount;
        }

        if (splits) expense.splits = splits;
        if (items) expense.items = items;

        await expense.save();

        const populatedExpense = await Expense.findById(expense._id)
            .populate('paidBy', 'username email')
            .populate('addedBy', 'username email')
            .populate('splits.user', 'username email')
            .populate('items.assignedTo', 'username email');

        res.json(populatedExpense);
    } catch (err) {
        console.error(err.message);
        if (err.kind === 'ObjectId') {
            return res.status(404).json({ msg: 'Expense not found' });
        }
        res.status(500).send('Server Error');
    }
});

// @route   GET api/expenses/activity
// @desc    Get all recent activity/expenses for the user
router.get('/activity', auth, async (req, res) => {
    try {
        const expenses = await Expense.find({
            $or: [
                { paidBy: req.user.id },
                { 'splits.user': req.user.id }
            ]
        })
            .sort({ date: -1 })
            .populate('paidBy', 'username')
            .populate('addedBy', 'username')
            .populate('splits.user', 'username')
            .populate('group', 'name')
            .limit(30);

        res.json(expenses);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

module.exports = router;
