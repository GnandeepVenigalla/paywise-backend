const mongoose = require('mongoose');

/**
 * LoanRequest tracks the lifecycle of a loan agreement between two users.
 * Interest on the associated expense only starts accruing once the borrower accepts.
 *
 * Acceptance flow:
 *   amount <= SMALL_LIMIT  → simple one-tap accept (no PIN)
 *   amount >  SMALL_LIMIT  → borrower must enter their account password to confirm
 *
 * The scheduler checks: isLoan=true AND loanRequest.status='accepted'
 * and uses acceptedAt as the interest start date.
 */
const SMALL_LOAN_LIMIT_USD = 100; // amounts in USD equivalent

const LoanRequestSchema = new mongoose.Schema({
    expense: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Expense',
        required: true,
        unique: true   // One loan request per expense
    },
    lender: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    borrower: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    amount: { type: Number, required: true },
    currency: { type: String, default: 'USD' },
    interestRate: { type: Number, required: true }, // APR %
    status: {
        type: String,
        enum: ['pending', 'accepted', 'rejected'],
        default: 'pending'
    },
    requiresPasswordConfirmation: {
        type: Boolean,
        default: false   // set to true server-side when amount > $100 equivalent
    },
    acceptedAt: { type: Date, default: null },
    rejectedAt: { type: Date, default: null },
    // Notification tracking: has lender been warned that acceptance is pending?
    lenderNotifiedAt: { type: Date, default: null },
}, { timestamps: true });

module.exports = mongoose.model('LoanRequest', LoanRequestSchema);
module.exports.SMALL_LOAN_LIMIT_USD = SMALL_LOAN_LIMIT_USD;
