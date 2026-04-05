const express = require('express');
const router = express.Router();
const Expense = require('../models/Expense');
const Group = require('../models/Group');
const User = require('../models/User');
const auth = require('../middleware/auth');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const logActivity = require('../utils/activityLogger');
const { notifyExpenseAction, notifyCommunityUpdate } = require('../utils/expenseNotifier');

// @route   POST api/expenses
// @desc    Add an expense
router.post('/', auth, async (req, res) => {
    try {
        const { description, amount, currency, group, paidBy, splits, items, isLoan, loanInterestRate } = req.body;
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
            items: items || [],
            isLoan: isLoan || false,
            loanInterestRate: loanInterestRate || 0
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

        // ── Email notifications (non-blocking) ──────────────────────────
        const isSettleUp = description?.toLowerCase().includes('settle up') ||
            description?.toLowerCase().startsWith('partial cash payment') ||
            description?.toLowerCase().startsWith('cash settle up') ||
            description?.toLowerCase().startsWith('settle my share') ||
            description?.includes('[sid:');
        notifyExpenseAction({
            actionType: isSettleUp ? 'settled' : 'added',
            expense,
            actorId: req.user.id,
            groupId: group || null,
        });
        // ────────────────────────────────────────────────────────────────


        // ── Auto-create LoanRequest for loan expenses ────────────────────
        let loanRequest = null;
        if (isLoan && loanInterestRate > 0 && !isSettleUp) {
            try {
                const LoanRequest = require('../models/LoanRequest');
                const { convertAmount } = require('../utils/currency');

                // Find the borrower (first split user that isn't the payer)
                const lenderId = (paidBy || req.user.id).toString();
                const borrowerSplit = (splits || []).find(s => {
                    const uid = (s.user?._id || s.user).toString();
                    return uid !== lenderId;
                });

                if (borrowerSplit) {
                    const borrowerId = (borrowerSplit.user?._id || borrowerSplit.user).toString();
                    const amountInUSD = convertAmount(amount, currency || 'USD', 'USD');
                    const requiresPassword = amountInUSD > 100;

                    // Remove old if exists (idempotent)
                    await LoanRequest.deleteOne({ expense: expense._id });

                    // If the person creating the expense is the borrower, they have inherently accepted the loan's terms (interest, etc).
                    // We only require 'pending' status if the Lender created it and needs the Borrower to confirm.
                    const isBorrowerCreating = req.user.id === borrowerId;
                    
                    loanRequest = await new LoanRequest({
                        expense: expense._id,
                        lender: lenderId,
                        borrower: borrowerId,
                        amount,
                        currency: currency || 'USD',
                        interestRate: loanInterestRate,
                        requiresPasswordConfirmation: isBorrowerCreating ? false : requiresPassword,
                        status: isBorrowerCreating ? 'accepted' : 'pending',
                        acceptedAt: isBorrowerCreating ? new Date() : null
                    }).save();

                    console.log(`[Expenses] LoanRequest created for expense ${expense._id}, borrower ${borrowerId}, requiresPassword: ${requiresPassword}`);
                }
            } catch (loanErr) {
                console.error('[Expenses] Failed to create LoanRequest:', loanErr.message);
            }
        }
        // ────────────────────────────────────────────────────────────────

        // ── Community Group Cycle Logic ──────────────────────────────────
        if (group) {
            try {
                const targetGroup = await Group.findById(group);
                if (targetGroup && targetGroup.groupType === 'community') {
                    const payerId = (paidBy || req.user.id).toString();
                    
                    // Mark payer as having paid in the current cycle
                    let memberFound = false;
                    const updatedCycle = targetGroup.paymentCycle.map(item => {
                        const itemId = item.user?._id?.toString() || item.user?.toString();
                        if (itemId === payerId) {
                            memberFound = true;
                            return { user: itemId, hasPaid: true };
                        }
                        return { user: itemId, hasPaid: item.hasPaid };
                    });

                    // Update cycle on document
                    targetGroup.paymentCycle = updatedCycle;

                    // If payer wasn't in the cycle, add them (edge case)
                    if (!memberFound) {
                        targetGroup.paymentCycle.push({ user: payerId, hasPaid: true });
                    }

                    // Check if EVERY member in the current group has paid
                    const activeCycleMemberIds = targetGroup.members.map(m => m.toString());
                    const cycleStatuses = targetGroup.paymentCycle.filter(item => {
                        const itemId = item.user?._id?.toString() || item.user?.toString();
                        return activeCycleMemberIds.includes(itemId);
                    });
                    
                    const allPaid = cycleStatuses.length > 0 && cycleStatuses.every(item => item.hasPaid);
                    
                    if (allPaid) {
                        // Reset the cycle for all active members
                        targetGroup.paymentCycle = targetGroup.paymentCycle.map(item => {
                            const itemId = item.user?._id?.toString() || item.user?.toString();
                            if (activeCycleMemberIds.includes(itemId)) {
                                return { user: itemId, hasPaid: false };
                            }
                            return item;
                        });
                    }

                    await targetGroup.save();

                    // ─── Trigger Community Notifications ───────────────────
                    notifyCommunityUpdate({
                        group: targetGroup._id,
                        actorId: req.user.id,
                        expenseDescription: description
                    });
                }
            } catch (groupErr) {
                // Don't crash the whole expense if cycle update fails, just log it.
                console.error('[Expenses] Post-Save Cycle update error:', groupErr.message);
            }
        }
        // ──────────────────────────────────────────────────────────────────

        res.json({ ...expense.toObject(), loanRequest });
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

// @route   DELETE api/expenses/friends/:friendId/all
// @desc    After full settle-up: delete ALL direct expenses between two users & notify friend
router.delete('/friends/:friendId/all', auth, async (req, res) => {
    try {
        const User = require('../models/User');
        const sendEmail = require('../utils/sendEmail');
        const { notifyMany } = require('../utils/notificationService');

        const me = await User.findById(req.user.id).select('username email');
        const friend = await User.findById(req.params.friendId).select('username email notificationSettings');

        if (!friend) return res.status(404).json({ msg: 'Friend not found' });

        // Optional: exclude the settle expense just posted so balance stays $0
        const keepId = req.query.keepId;

        // Delete all direct (non-group) expenses between the two users, except the settle expense
        const deleteQuery = {
            group: null,
            $or: [
                { paidBy: req.user.id, 'splits.user': friend._id },
                { paidBy: friend._id, 'splits.user': req.user.id }
            ]
        };
        if (keepId) {
            const mongoose = require('mongoose');
            try { deleteQuery._id = { $ne: new mongoose.Types.ObjectId(keepId) }; } catch (_) {}
        }

        const deleteResult = await Expense.deleteMany(deleteQuery);

        console.log(`[SettleClear] Deleted ${deleteResult.deletedCount} expenses between ${me.username} and ${friend.username}`);

        // ── Email the friend (non-blocking) ─────────────────────────────────
        const emailHtml = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>All Settled — Paywise</title></head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f8fafc;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;padding:32px 0;">
    <tr><td align="center">
      <table width="100%" style="max-width:520px;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">
        <tr><td style="background:linear-gradient(135deg,#064e3b 0%,#065f46 100%);padding:28px 32px;text-align:center;">
          <h1 style="margin:0;color:#fff;font-size:22px;font-weight:800;">Paywise</h1>
          <p style="margin:4px 0 0;color:#a7f3d0;font-size:13px;">Smart Bill Splitting</p>
        </td></tr>
        <tr><td style="background:#f0fdf4;border-bottom:2px solid #16a34a30;padding:24px 32px;text-align:center;">
          <span style="font-size:36px;">🎉</span>
          <p style="margin:8px 0 0;font-size:18px;font-weight:800;color:#16a34a;text-transform:uppercase;letter-spacing:0.05em;">All Settled!</p>
        </td></tr>
        <tr><td style="padding:28px 32px;">
          <p style="margin:0 0 20px;font-size:16px;color:#374151;line-height:1.6;">
            Hi <strong>${friend.username}</strong>,<br>
            <strong>${me.username}</strong> has fully settled up with you on Paywise 🤝<br><br>
            Your shared expense history has been <strong>cleared</strong> — you're starting fresh!
          </p>
          <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:12px;padding:16px 20px;margin-bottom:24px;">
            <p style="margin:0;font-size:14px;color:#15803d;">
              ✅ Balance with <strong>${me.username}</strong>: <span style="font-weight:900;font-size:16px;">$0.00</span><br>
              <span style="font-size:12px;color:#16a34a;margin-top:4px;display:block;">All expenses cleared. Fresh start! 🌱</span>
            </p>
          </div>
          <div style="text-align:center;">
            <a href="https://paywiseapp.com" style="display:inline-block;background:#059669;color:#fff;font-size:15px;font-weight:700;padding:14px 32px;border-radius:10px;text-decoration:none;">Open Paywise →</a>
          </div>
        </td></tr>
        <tr><td style="padding:16px 32px 28px;text-align:center;border-top:1px solid #f3f4f6;">
          <p style="margin:0;font-size:12px;color:#9ca3af;">
            <a href="https://paywiseapp.com/account" style="color:#059669;text-decoration:none;">Manage settings</a> · <a href="https://paywiseapp.com" style="color:#9ca3af;text-decoration:none;">paywiseapp.com</a>
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

        if (friend.notificationSettings?.expensePaid !== false) {
            sendEmail({
                email: friend.email,
                subject: `🎉 ${me.username} settled up with you — all clear!`,
                message: `Hi ${friend.username},\n\n${me.username} fully settled up with you on Paywise! Your balance is now $0.00 and your shared history has been cleared.\n\nFresh start! 🌱\n\nhttps://paywiseapp.com\n\n— The Paywise Team`,
                html: emailHtml,
            }).catch(err => console.error('[SettleClear] Email error:', err.message));
        }

        // ── In-app notification ──────────────────────────────────────────────
        notifyMany({
            recipientIds: [friend._id.toString()],
            title: `🎉 ${me.username} settled up — all clear!`,
            message: `${me.username} fully settled and cleared your shared history. Balance is $0!`,
            category: 'expense',
            type: 'success',
            actionUrl: `/friend/${req.user.id}`,
            metadata: { actionType: 'settled_clear', actorId: req.user.id }
        }).catch(err => console.error('[SettleClear] Notify error:', err.message));

        res.json({ msg: `Cleared ${deleteResult.deletedCount} expenses and notified ${friend.username}.` });
    } catch (err) {
        console.error('[SettleClear] Error:', err.message);
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

        let expenses = await Expense.find({
            $or: [
                { paidBy: req.user.id, 'splits.user': friend._id },
                { paidBy: friend._id, 'splits.user': req.user.id }
            ]
        })
            .sort({ date: -1 })
            .populate('group', 'name groupType')
            .populate('paidBy', 'username email')
            .populate('addedBy', 'username email')
            .populate('splits.user', 'username email');

        expenses = expenses.filter(exp => !(exp.group && typeof exp.group === 'object' && exp.group.groupType === 'community'));

        const { convertAmount } = require('../utils/currency');

        // --- Detect dominant currency ---
        // Tally the total split value per currency to find which currency dominates.
        // If all expenses are in ONE currency (e.g. both users in India → all INR),
        // we skip USD conversion entirely and return balance in that currency.
        const currencyTotals = {};
        expenses.forEach(exp => {
            const c = (exp.currency || 'USD').toUpperCase();
            const isPaidByMe = exp.paidBy._id.toString() === req.user.id;
            let splitAmt = 0;
            if (isPaidByMe) {
                const fSplit = exp.splits.find(s => s.user._id.toString() === friend._id.toString());
                if (fSplit) splitAmt = fSplit.amount;
            } else {
                const mySplit = exp.splits.find(s => s.user._id.toString() === req.user.id);
                if (mySplit) splitAmt = mySplit.amount;
            }
            if (splitAmt > 0) currencyTotals[c] = (currencyTotals[c] || 0) + splitAmt;
        });

        const currencies = Object.keys(currencyTotals);
        const dominantCurrency = currencies.length === 1
            ? currencies[0]  // Pure single-currency: no conversion needed
            : 'USD';         // Mixed currencies: normalise through USD

        // --- Calculate balance in dominantCurrency ---
        let balance = 0;
        expenses.forEach(exp => {
            const isPaidByMe = exp.paidBy._id.toString() === req.user.id;
            const sourceCurr = (exp.currency || 'USD').toUpperCase();
            if (isPaidByMe) {
                const fSplit = exp.splits.find(s => s.user._id.toString() === friend._id.toString());
                if (fSplit) {
                    balance += Math.round(convertAmount(fSplit.amount, sourceCurr, dominantCurrency) * 100) / 100;
                }
            } else {
                const mySplit = exp.splits.find(s => s.user._id.toString() === req.user.id);
                if (mySplit) {
                    balance -= Math.round(convertAmount(mySplit.amount, sourceCurr, dominantCurrency) * 100) / 100;
                }
            }
        });

        balance = Math.round(balance * 100) / 100;

        // Return balanceCurrency so the frontend knows what currency the balance is in
        // and can display it without any further conversion.
        res.json({ friend, expenses, balance, balanceCurrency: dominantCurrency });
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

// @route   POST api/expenses/:id/settle-my-share
// @desc    Settle a specific expense share: notify payer + delete the expense
router.post('/:id/settle-my-share', auth, async (req, res) => {
    try {
        const sendEmail = require('../utils/sendEmail');
        const { notifyMany } = require('../utils/notificationService');
        const { getCurrencySymbol } = require('../utils/currency');

        const expense = await Expense.findById(req.params.id)
            .populate('paidBy', 'username email notificationSettings')
            .populate('splits.user', 'username email');

        if (!expense) return res.status(404).json({ msg: 'Expense not found' });

        const myId = req.user.id.toString();

        // Must be in the splits (not the payer)
        const mySplit = expense.splits.find(s => (s.user?._id || s.user).toString() === myId);
        if (!mySplit) {
            return res.status(403).json({ msg: 'You are not a participant in this expense.' });
        }
        const paidById = (expense.paidBy?._id || expense.paidBy).toString();
        if (paidById === myId) {
            return res.status(400).json({ msg: 'You are the payer — you cannot settle your own expense.' });
        }

        const me = await User.findById(myId).select('username');
        const payer = expense.paidBy;
        const sym = getCurrencySymbol(expense.currency || 'USD');
        const amtDisplay = `${sym}${Number(mySplit.amount).toFixed(2)}`;

        // Capture snapshot before deleting
        const snapshot = {
            description: expense.description,
            amount: mySplit.amount,
            currency: expense.currency,
            paidBy: { _id: payer._id, username: payer.username },
            splits: expense.splits,
        };

        // ── Delete the expense ───────────────────────────────────────────────
        await expense.deleteOne();

        // ── Email the payer ─────────────────────────────────────────────────
        const emailHtml = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Expense Settled — Paywise</title></head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f8fafc;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;padding:32px 0;">
    <tr><td align="center">
      <table width="100%" style="max-width:520px;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">
        <tr><td style="background:linear-gradient(135deg,#064e3b 0%,#065f46 100%);padding:28px 32px;text-align:center;">
          <h1 style="margin:0;color:#fff;font-size:22px;font-weight:800;">Paywise</h1>
          <p style="margin:4px 0 0;color:#a7f3d0;font-size:13px;">Smart Bill Splitting</p>
        </td></tr>
        <tr><td style="background:#f0fdf4;border-bottom:2px solid #16a34a30;padding:20px 32px;text-align:center;">
          <span style="font-size:32px;">✅</span>
          <p style="margin:8px 0 0;font-size:16px;font-weight:800;color:#16a34a;text-transform:uppercase;letter-spacing:0.05em;">Share Settled!</p>
        </td></tr>
        <tr><td style="padding:28px 32px;">
          <p style="margin:0 0 20px;font-size:16px;color:#374151;line-height:1.6;">
            Hi <strong>${payer.username}</strong>,<br>
            <strong>${me.username}</strong> has settled their share of <strong>"${snapshot.description}"</strong>.
          </p>
          <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:12px;padding:16px 20px;margin-bottom:24px;">
            <p style="margin:0 0 4px;font-size:12px;font-weight:700;color:#9ca3af;text-transform:uppercase;">Amount Settled</p>
            <p style="margin:0;font-size:22px;font-weight:900;color:#059669;">${amtDisplay}</p>
            <p style="margin:6px 0 0;font-size:13px;color:#6b7280;">for <em>${snapshot.description}</em></p>
          </div>
          <div style="text-align:center;">
            <a href="https://paywiseapp.com" style="display:inline-block;background:#059669;color:#fff;font-size:15px;font-weight:700;padding:14px 32px;border-radius:10px;text-decoration:none;">Open Paywise →</a>
          </div>
        </td></tr>
        <tr><td style="padding:16px 32px 28px;text-align:center;border-top:1px solid #f3f4f6;">
          <p style="margin:0;font-size:12px;color:#9ca3af;">
            <a href="https://paywiseapp.com/account" style="color:#059669;text-decoration:none;">Manage settings</a> · paywiseapp.com
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

        if (payer.notificationSettings?.expensePaid !== false) {
            sendEmail({
                email: payer.email,
                subject: `✅ ${me.username} settled "${snapshot.description}" — ${amtDisplay}`,
                message: `Hi ${payer.username},\n\n${me.username} settled their share (${amtDisplay}) of "${snapshot.description}" on Paywise.\n\nhttps://paywiseapp.com\n\n— The Paywise Team`,
                html: emailHtml,
            }).catch(err => console.error('[SettleMyShare] Email error:', err.message));
        }

        // ── In-app notification ──────────────────────────────────────────────
        notifyMany({
            recipientIds: [paidById],
            title: `✅ ${me.username} paid their share!`,
            message: `${me.username} settled ${amtDisplay} for "${snapshot.description}".`,
            category: 'expense',
            type: 'success',
            actionUrl: `/friend/${myId}`,
            metadata: { actionType: 'settled_share', actorId: myId }
        }).catch(err => console.error('[SettleMyShare] Notify error:', err.message));

        res.json({ msg: `Expense settled and deleted. ${payer.username} has been notified.` });
    } catch (err) {
        console.error('[SettleMyShare] Error:', err.message);
        if (err.kind === 'ObjectId') return res.status(404).json({ msg: 'Expense not found' });
        res.status(500).send('Server Error');
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

        // Capture data before deleting for the notification
        const deletedSnapshot = {
            description: expense.description,
            amount: expense.amount,
            currency: expense.currency,
            paidBy: expense.paidBy,
            splits: expense.splits,
        };
        const deletedGroupId = expense.group || null;

        await expense.deleteOne();

        // ── Email notifications (non-blocking) ──────────────────────────
        notifyExpenseAction({
            actionType: 'deleted',
            expense: deletedSnapshot,
            actorId: req.user.id,
            groupId: deletedGroupId,
        });
        // ────────────────────────────────────────────────────────────────

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

        const { description, amount, currency, splits, items, isLoan, loanInterestRate } = req.body;

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
        if (typeof isLoan !== 'undefined') expense.isLoan = isLoan;
        if (typeof loanInterestRate !== 'undefined') expense.loanInterestRate = loanInterestRate;

        await expense.save();

        const populatedExpense = await Expense.findById(expense._id)
            .populate('paidBy', 'username email')
            .populate('addedBy', 'username email')
            .populate('splits.user', 'username email')
            .populate('items.assignedTo', 'username email');

        // ── Auto-sync LoanRequest for loan expenses ────────────────────
        if (populatedExpense.isLoan && populatedExpense.loanInterestRate > 0) {
            try {
                const LoanRequest = require('../models/LoanRequest');
                const { convertAmount } = require('../utils/currency');

                const lenderId = (populatedExpense.paidBy._id || populatedExpense.paidBy).toString();
                const borrowerSplit = (populatedExpense.splits || []).find(s => {
                    const uid = (s.user?._id || s.user).toString();
                    return uid !== lenderId;
                });

                if (borrowerSplit) {
                    const borrowerId = (borrowerSplit.user?._id || borrowerSplit.user).toString();
                    const amountInUSD = convertAmount(populatedExpense.amount, populatedExpense.currency || 'USD', 'USD');
                    const requiresPassword = amountInUSD > 100;

                    await LoanRequest.deleteOne({ expense: populatedExpense._id });

                    const isBorrowerCreating = req.user.id === borrowerId;
                    
                    await new LoanRequest({
                        expense: populatedExpense._id,
                        lender: lenderId,
                        borrower: borrowerId,
                        amount: populatedExpense.amount,
                        currency: populatedExpense.currency || 'USD',
                        interestRate: populatedExpense.loanInterestRate,
                        requiresPasswordConfirmation: isBorrowerCreating ? false : requiresPassword,
                        status: isBorrowerCreating ? 'accepted' : 'pending', // Borrower editing/creating inherently accepts
                        acceptedAt: isBorrowerCreating ? new Date() : null
                    }).save();
                }
            } catch (loanErr) {
                console.error('[Expenses] Failed to update/create LoanRequest on edit:', loanErr.message);
            }
        } else if (typeof isLoan !== 'undefined' && !isLoan) {
            // Remove loan request if isLoan is set to false
            try {
                const LoanRequest = require('../models/LoanRequest');
                await LoanRequest.deleteOne({ expense: populatedExpense._id });
            } catch (err) {}
        }
        // ────────────────────────────────────────────────────────────────

        // ── Email notifications (non-blocking) ──────────────────────────
        notifyExpenseAction({
            actionType: 'edited',
            expense: populatedExpense,
            actorId: req.user.id,
            groupId: populatedExpense.group || null,
        });
        // ────────────────────────────────────────────────────────────────

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
