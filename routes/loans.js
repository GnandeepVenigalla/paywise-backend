const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const auth = require('../middleware/auth');
const LoanRequest = require('../models/LoanRequest');
const Expense = require('../models/Expense');
const User = require('../models/User');
const { convertAmount } = require('../utils/currency');
const { notifyExpenseAction } = require('../utils/expenseNotifier');
const sendEmail = require('../utils/sendEmail');

const SMALL_LIMIT = LoanRequest.SMALL_LOAN_LIMIT_USD;

const CURRENCY_SYMBOLS = {
    USD: '$', EUR: '€', GBP: '£', INR: '₹', CAD: 'CA$', AUD: 'A$', JPY: '¥', 
    CNY: '¥', CHF: 'CHF', MXN: 'MX$', BRL: 'R$', SGD: 'S$', AED: 'AED'
};
const getSym = (code) => CURRENCY_SYMBOLS[code] || code || '$';

// ─── Helper: build loan notification email ──────────────────────────────────
async function sendLoanEmail({ toUser, fromUser, expense, action, loanRequest }) {
    const s = getSym(expense.currency);
    const amt = `${s}${expense.amount.toFixed(2)}`;
    const appUrl = 'https://paywiseapp.com';

    const subjects = {
        requested:  `💰 ${fromUser.username} sent you a loan request — ${amt}`,
        accepted:   `✅ ${fromUser.username} accepted your loan of ${amt}`,
        rejected:   `❌ ${fromUser.username} declined your loan of ${amt}`,
        reminder:   `⏳ Loan pending acceptance — ${amt} (${expense.description})`,
    };

    const bodies = {
        requested: `Hi ${toUser.username},\n\n${fromUser.username} has sent you a loan request for "${expense.description}" (${amt}) at ${loanRequest.interestRate}% APR.\n\n${loanRequest.requiresPasswordConfirmation ? '⚠️ This loan exceeds $100 and requires your account password to accept.' : 'You can accept with a single tap in the app.'}\n\nOpen Paywise to accept or reject: ${appUrl}\n\n— Paywise`,
        accepted:  `Hi ${toUser.username},\n\n${fromUser.username} has accepted your loan for "${expense.description}" (${amt}).\n\nInterest at ${loanRequest.interestRate}% APR will now start accruing from today.\n\nOpen Paywise: ${appUrl}\n\n— Paywise`,
        rejected:  `Hi ${toUser.username},\n\n${fromUser.username} has declined your loan for "${expense.description}" (${amt}).\n\nNo interest will be charged. The expense has been kept as a regular split.\n\nOpen Paywise: ${appUrl}\n\n— Paywise`,
        reminder:  `Hi ${toUser.username},\n\nYou sent a loan of ${amt} to ${fromUser.username} for "${expense.description}" that is still waiting for their acceptance.\n\n⚠️ Interest will NOT accrue until they accept. We recommend not issuing additional loans to this person until they respond.\n\nOpen Paywise: ${appUrl}\n\n— Paywise`,
    };

    try {
        await sendEmail({
            email: toUser.email,
            subject: subjects[action],
            message: bodies[action],
        });
    } catch (err) {
        console.error('[LoanRoutes] Failed to send loan email:', err.message);
    }
}

// ─── POST /api/loans ─────────────────────────────────────────────────────────
// Create a loan request. Called automatically when an expense is saved with isLoan=true.
router.post('/', auth, async (req, res) => {
    try {
        const { expenseId } = req.body;

        const expense = await Expense.findById(expenseId)
            .populate('paidBy', 'username email')
            .populate('splits.user', 'username email');

        if (!expense) return res.status(404).json({ msg: 'Expense not found' });
        if (!expense.isLoan) return res.status(400).json({ msg: 'Expense is not marked as a loan' });

        const lenderId = (expense.paidBy._id || expense.paidBy).toString();
        if (lenderId !== req.user.id) {
            return res.status(403).json({ msg: 'Only the lender can initiate a loan request' });
        }

        const borrowerSplit = expense.splits.find(s => {
            const uid = (s.user._id || s.user).toString();
            return uid !== lenderId;
        });
        if (!borrowerSplit) return res.status(400).json({ msg: 'No borrower found in expense splits' });

        const borrowerId = (borrowerSplit.user._id || borrowerSplit.user).toString();
        const borrowerUser = await User.findById(borrowerId).select('username email');
        const lenderUser = expense.paidBy;

        await LoanRequest.deleteOne({ expense: expenseId });

        const amountInUSD = convertAmount(expense.amount, expense.currency || 'USD', 'USD');
        const requiresPassword = amountInUSD > SMALL_LIMIT;

        const loanReq = new LoanRequest({
            expense: expenseId,
            lender: lenderId,
            borrower: borrowerId,
            amount: expense.amount,
            currency: expense.currency || 'USD',
            interestRate: expense.loanInterestRate,
            requiresPasswordConfirmation: requiresPassword,
        });
        await loanReq.save();

        const { createNotification } = require('../utils/notificationService');
        await createNotification({
            recipientId: borrowerId,
            title: `💰 Loan request from ${lenderUser.username}`,
            message: `${lenderUser.username} sent you a loan request for "${expense.description}" (${getSym(expense.currency)}${expense.amount}).`,
            category: 'loan',
            type: 'info',
            actionUrl: `/friends/${lenderId}`,
            metadata: { loanRequestId: loanReq._id, expenseId }
        });

        res.json({ loanRequest: loanReq, requiresPassword });
    } catch (err) {
        console.error('[LoanRoutes] POST /loans:', err.message);
        res.status(500).send('Server Error');
    }
});

// ─── GET /api/loans/pending ──────────────────────────────────────────────────
router.get('/pending', auth, async (req, res) => {
    try {
        const pending = await LoanRequest.find({
            borrower: req.user.id,
            status: 'pending'
        })
            .populate('expense')
            .populate('lender', 'username email profilePic')
            .sort({ createdAt: -1 });

        res.json(pending);
    } catch (err) {
        console.error('[LoanRoutes] GET /loans/pending:', err.message);
        res.status(500).send('Server Error');
    }
});

// ─── GET /api/loans/sent ────────────────────────────────────────────────────
router.get('/sent', auth, async (req, res) => {
    try {
        const sent = await LoanRequest.find({ lender: req.user.id })
            .populate('expense')
            .populate('borrower', 'username email profilePic')
            .sort({ createdAt: -1 });

        res.json(sent);
    } catch (err) {
        console.error('[LoanRoutes] GET /loans/sent:', err.message);
        res.status(500).send('Server Error');
    }
});

// ─── GET /api/loans/expense/:expenseId ──────────────────────────────────────
router.get('/expense/:expenseId', auth, async (req, res) => {
    try {
        const loanReq = await LoanRequest.findOne({ expense: req.params.expenseId })
            .populate('lender', 'username email profilePic')
            .populate('borrower', 'username email profilePic');

        if (!loanReq) return res.status(404).json({ msg: 'No loan request found for this expense' });
        res.json(loanReq);
    } catch (err) {
        res.status(500).send('Server Error');
    }
});

// ─── POST /api/loans/:id/accept ─────────────────────────────────────────────
router.post('/:id/accept', auth, async (req, res) => {
    try {
        const loanReq = await LoanRequest.findById(req.params.id)
            .populate('expense')
            .populate('lender', 'username email notificationSettings')
            .populate('borrower', 'username email');

        if (!loanReq) return res.status(404).json({ msg: 'Loan request not found' });

        const borrowerId = (loanReq.borrower._id || loanReq.borrower).toString();
        if (borrowerId !== req.user.id) {
            return res.status(403).json({ msg: 'Only the borrower can accept this loan' });
        }
        if (loanReq.status !== 'pending') {
            return res.status(400).json({ msg: `Loan is already ${loanReq.status}` });
        }

        if (loanReq.requiresPasswordConfirmation) {
            const { password } = req.body;
            if (!password) {
                return res.status(400).json({
                    msg: 'Password required to accept this loan (amount exceeds $100)',
                    requiresPassword: true
                });
            }
            const borrowerUser = await User.findById(req.user.id);
            if (!borrowerUser.password) {
                return res.status(400).json({ msg: 'Your account uses Google Sign-In. Please set a password in Account Settings first.' });
            }
            const isMatch = await bcrypt.compare(password, borrowerUser.password);
            if (!isMatch) {
                return res.status(401).json({ msg: 'Incorrect password. Loan not accepted.' });
            }
        }

        const now = new Date();
        loanReq.status = 'accepted';
        loanReq.acceptedAt = now;
        await loanReq.save();

        const expense = await Expense.findById(loanReq.expense._id || loanReq.expense);
        if (expense) {
            expense.lastInterestApplied = null;
            expense.date = now;
            await expense.save();
        }

        const { createNotification } = require('../utils/notificationService');
        await createNotification({
            recipientId: loanReq.lender._id,
            title: `✅ Loan accepted by ${loanReq.borrower.username}`,
            message: `${loanReq.borrower.username} accepted your loan of ${getSym(loanReq.expense.currency)}${loanReq.expense.amount.toFixed(2)}.`,
            category: 'loan',
            type: 'success',
            actionUrl: `/friends/${borrowerId}`,
            metadata: { loanRequestId: loanReq._id }
        });

        res.json({ msg: 'Loan accepted. Interest will start accruing from today.', loanRequest: loanReq });
    } catch (err) {
        console.error('[LoanRoutes] POST /:id/accept:', err.message);
        res.status(500).send('Server Error');
    }
});

// ─── POST /api/loans/:id/reject ─────────────────────────────────────────────
router.post('/:id/reject', auth, async (req, res) => {
    try {
        const loanReq = await LoanRequest.findById(req.params.id)
            .populate('expense')
            .populate('lender', 'username email notificationSettings')
            .populate('borrower', 'username email');

        if (!loanReq) return res.status(404).json({ msg: 'Loan request not found' });

        const borrowerId = (loanReq.borrower._id || loanReq.borrower).toString();
        if (borrowerId !== req.user.id) {
            return res.status(403).json({ msg: 'Only the borrower can reject this loan' });
        }
        if (loanReq.status !== 'pending') {
            return res.status(400).json({ msg: `Loan is already ${loanReq.status}` });
        }

        loanReq.status = 'rejected';
        loanReq.rejectedAt = new Date();
        await loanReq.save();

        const expense = await Expense.findById(loanReq.expense._id || loanReq.expense);
        if (expense) {
            expense.loanInterestRate = 0;
            expense.isLoan = true;
            await expense.save();
        }

        const { createNotification } = require('../utils/notificationService');
        await createNotification({
            recipientId: loanReq.lender._id,
            title: `❌ Loan declined by ${loanReq.borrower.username}`,
            message: `${loanReq.borrower.username} declined your loan of ${getSym(loanReq.expense.currency)}${loanReq.expense.amount.toFixed(2)}.`,
            category: 'loan',
            type: 'warning',
            actionUrl: `/friends/${borrowerId}`,
            metadata: { loanRequestId: loanReq._id }
        });

        res.json({ msg: 'Loan rejected. No interest will be applied.', loanRequest: loanReq });
    } catch (err) {
        console.error('[LoanRoutes] POST /:id/reject:', err.message);
        res.status(500).send('Server Error');
    }
});

module.exports = router;
